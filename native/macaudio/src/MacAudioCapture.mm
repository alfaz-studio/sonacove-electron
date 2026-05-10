// MacAudioCapture.mm — see header for the why.

#import "MacAudioCapture.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

@interface SonacoveAudioStreamOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property (nonatomic) sonacove::AudioBufferCallback audioCallback;
@property (nonatomic) sonacove::ErrorCallback errorCallback;
@end

@implementation SonacoveAudioStreamOutput

// SCStreamOutput: arrives on whatever queue the stream was added with.
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio || !sampleBuffer) {
        return;
    }
    if (!CMSampleBufferDataIsReady(sampleBuffer)) {
        return;
    }

    CMFormatDescriptionRef desc = CMSampleBufferGetFormatDescription(sampleBuffer);

    if (!desc) {
        return;
    }

    const AudioStreamBasicDescription* asbd =
        CMAudioFormatDescriptionGetStreamBasicDescription(desc);

    if (!asbd) {
        return;
    }

    // ScreenCaptureKit delivers interleaved Float32 by default; bail loudly
    // if a future macOS picks a different default rather than silently
    // forwarding garbage to JS.
    const bool isFloat = (asbd->mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    const bool isInterleaved =
        (asbd->mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0;

    if (!isFloat || !isInterleaved || asbd->mBitsPerChannel != 32) {
        if (self.errorCallback) {
            self.errorCallback(-2, "Unexpected audio format from SCStream");
        }

        return;
    }

    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);

    if (!blockBuffer) {
        return;
    }

    size_t totalLen = 0;
    char* dataPtr = nullptr;
    OSStatus s =
        CMBlockBufferGetDataPointer(blockBuffer, 0, nullptr, &totalLen, &dataPtr);

    if (s != kCMBlockBufferNoErr || !dataPtr || totalLen == 0) {
        return;
    }

    const uint32_t channels = asbd->mChannelsPerFrame;
    const size_t bytesPerFrame = sizeof(float) * channels;

    if (bytesPerFrame == 0) {
        return;
    }

    const size_t frameCount = totalLen / bytesPerFrame;

    sonacove::AudioFormat fmt{};
    fmt.sampleRate = asbd->mSampleRate;
    fmt.channelCount = channels;

    if (self.audioCallback) {
        self.audioCallback(reinterpret_cast<const float*>(dataPtr), frameCount,
                           fmt);
    }
}

// SCStreamDelegate: the OS gave up on the stream.
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    if (self.errorCallback) {
        const int code = static_cast<int>(error.code);
        const char* msg = error.localizedDescription.UTF8String;

        self.errorCallback(code, msg ? msg : "stream stopped");
    }
}

@end

namespace sonacove {

struct MacAudioCapture::Impl {
    SCStream* stream = nil;
    SonacoveAudioStreamOutput* output = nil;
    dispatch_queue_t deliveryQueue = nullptr;
    bool running = false;
};

MacAudioCapture::MacAudioCapture() : impl_(new Impl()) {
    impl_->deliveryQueue = dispatch_queue_create(
        "com.sonacove.macaudio.delivery", DISPATCH_QUEUE_SERIAL);
}

MacAudioCapture::~MacAudioCapture() {
    stop();
    delete impl_;
}

bool MacAudioCapture::isRunning() const {
    return impl_->running;
}

bool MacAudioCapture::start(double sampleRate, uint32_t channelCount,
                            AudioBufferCallback onAudio, ErrorCallback onError) {
    if (impl_->running) {
        return true;
    }

    if (@available(macOS 13.0, *)) {
        // Capture-with-audio config. The stream will be filtered against the
        // primary display below — we don't actually use the video frames, but
        // SCStream requires a content filter even for audio-only capture.
        SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];

        config.capturesAudio = YES;
        config.excludesCurrentProcessAudio = YES;
        config.sampleRate = static_cast<NSInteger>(sampleRate);
        config.channelCount = static_cast<NSInteger>(channelCount);

        // Minimum-viable video config: 2x2 pixels at 1 fps. We won't read the
        // frames, but SCStream requires a video config — making it tiny keeps
        // the OS from spending GPU cycles on a stream we ignore.
        config.width = 2;
        config.height = 2;
        config.minimumFrameInterval = CMTimeMake(1, 1);
        config.queueDepth = 8;

        SonacoveAudioStreamOutput* output = [[SonacoveAudioStreamOutput alloc] init];

        output.audioCallback = onAudio;
        output.errorCallback = onError;
        impl_->output = output;

        // Async because SCShareableContent fetches via XPC. Set running=true
        // optimistically; if discovery or start fails, the error callback
        // surfaces it and stop() is safe to call from JS.
        impl_->running = true;

        AudioBufferCallback __block onAudioCopy = onAudio;
        ErrorCallback __block onErrorCopy = onError;
        Impl* __block implPtr = impl_;
        SCStreamConfiguration* __block configCapture = config;
        SonacoveAudioStreamOutput* __block outputCapture = output;

        [SCShareableContent
            getShareableContentExcludingDesktopWindows:NO
                                   onScreenWindowsOnly:NO
                                     completionHandler:^(SCShareableContent* content,
                                                         NSError* err) {
              if (err || content.displays.count == 0) {
                  if (onErrorCopy) {
                      const char* m = err
                                          ? err.localizedDescription.UTF8String
                                          : "no displays available";

                      onErrorCopy(err ? (int) err.code : -1,
                                  m ? m : "shareable content unavailable");
                  }

                  return;
              }

              SCDisplay* primary = content.displays.firstObject;
              SCContentFilter* filter =
                  [[SCContentFilter alloc] initWithDisplay:primary
                                          excludingWindows:@[]];

              SCStream* s =
                  [[SCStream alloc] initWithFilter:filter
                                    configuration:configCapture
                                         delegate:outputCapture];

              NSError* addErr = nil;

              [s addStreamOutput:outputCapture
                            type:SCStreamOutputTypeAudio
              sampleHandlerQueue:implPtr->deliveryQueue
                           error:&addErr];

              if (addErr) {
                  if (onErrorCopy) {
                      onErrorCopy((int) addErr.code,
                                  addErr.localizedDescription.UTF8String);
                  }

                  return;
              }

              implPtr->stream = s;

              [s startCaptureWithCompletionHandler:^(NSError* startErr) {
                if (startErr && onErrorCopy) {
                    onErrorCopy((int) startErr.code,
                                startErr.localizedDescription.UTF8String);
                }
              }];
            }];

        return true;
    } else {
        if (onError) {
            onError(-3, "macOS 13.0 or later required for system audio capture");
        }

        return false;
    }
}

void MacAudioCapture::stop() {
    if (!impl_->running) {
        return;
    }

    impl_->running = false;

    if (@available(macOS 13.0, *)) {
        SCStream* s = impl_->stream;
        impl_->stream = nil;
        impl_->output = nil;

        if (s) {
            [s stopCaptureWithCompletionHandler:^(NSError*){}];
        }
    }
}

} // namespace sonacove
