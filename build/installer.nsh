; The app is installed per machine, so the installer itself needs elevation.
RequestExecutionLevel admin

; Focus blocking does not install a Windows service. The app starts its own
; elevated helper on demand (a UAC prompt, once per app run) — see
; docs/ADR-FOCUS.md. There is therefore nothing to register at install time
; and nothing to unregister at uninstall time.
!macro customInstall
!macroend

; "Start with Windows" is a per-user Run entry written by the app itself (never
; by the installer), named after the app id. A real uninstall removes it so no
; stale startup entry is left pointing at a deleted executable. An update also
; runs this macro; the entry is kept then, so the updated app still starts at
; sign-in (and it re-checks the entry at every start anyway).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.tanmaychavan.productivitycoach"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.tanmaychavan.productivitycoach"
  ${endIf}
!macroend
