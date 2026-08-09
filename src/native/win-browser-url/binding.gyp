{
  "targets": [
    {
      "target_name": "win_browser_url",
      "sources": ["src/win_browser_url.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS=='win'", {
          "libraries": [
            "-luiautomationcore",
            "-lole32",
            "-luuid"
          ],
          "sources": ["src/win_browser_url.cc"]
        }]
      ]
    }
  ]
}
