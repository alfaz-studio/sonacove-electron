{
  "targets": [
    {
      "target_name": "macaudio",
      "sources": [
        "src/binding.mm",
        "src/MacAudioCapture.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "MACOSX_DEPLOYMENT_TARGET": "13.0",
            "GCC_ENABLE_OBJC_EXCEPTIONS": "YES",
            "OTHER_CFLAGS": ["-fobjc-arc"]
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/ScreenCaptureKit.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreMedia.framework",
              "$(SDKROOT)/System/Library/Frameworks/AVFoundation.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreAudio.framework",
              "$(SDKROOT)/System/Library/Frameworks/Foundation.framework"
            ]
          }
        }]
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NODE_ADDON_API_DISABLE_DEPRECATED"]
    }
  ]
}
