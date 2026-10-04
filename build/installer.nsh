; The app is installed per machine, so the installer itself needs elevation.
RequestExecutionLevel admin

; Focus blocking does not install a Windows service. The app starts its own
; elevated helper on demand (a UAC prompt, once per app run) — see
; docs/ADR-FOCUS.md. There is therefore nothing to register at install time
; and nothing to unregister at uninstall time.
!macro customInstall
!macroend

!macro customUnInstall
!macroend
