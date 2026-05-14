{
  "targets": [
    {
      "target_name": "winaudio",
      "sources": [
        "src/binding.cpp",
        "src/WinAudioCapture.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17", "/await", "/EHsc"],
              "ExceptionHandling": 1
            }
          },
          "defines": [
            "_WIN32_WINNT=0x0A00",
            "WINVER=0x0A00",
            "NOMINMAX",
            "WIN32_LEAN_AND_MEAN"
          ],
          "libraries": [
            "-lOle32.lib",
            "-lMmdevapi.lib",
            "-lAvrt.lib",
            "-lKsuser.lib",
            "-lPropsys.lib"
          ]
        }]
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "NODE_ADDON_API_DISABLE_DEPRECATED"]
    }
  ]
}
