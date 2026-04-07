{
  "targets": [
    {
      "target_name": "sonacove_loopback_capture",
      "conditions": [
        ["OS=='win'", {
          "sources": [
            "src/addon.cpp",
            "src/loopback_capture.cpp"
          ],
          "include_dirs": [
            "<!@(node -p \"require('node-addon-api').include\")"
          ],
          "defines": [
            "NAPI_VERSION=8",
            "NAPI_DISABLE_CPP_EXCEPTIONS",
            "WIN32_LEAN_AND_MEAN",
            "NTDDI_VERSION=NTDDI_WIN10_FE",
            "_WIN32_WINNT=_WIN32_WINNT_WIN10"
          ],
          "libraries": [
            "-lole32",
            "-lmmdevapi",
            "-lavrt"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17"],
              "ExceptionHandling": 1
            }
          }
        }]
      ]
    }
  ]
}
