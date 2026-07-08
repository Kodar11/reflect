; Force UAC elevation prompt - required for service installation and hosts file access
RequestExecutionLevel admin

!macro customInstall
  DetailPrint "Installing Friction background service..."
  SetOutPath "$INSTDIR"

  StrCpy $0 "$INSTDIR\resources\app.asar.unpacked\dist-electron\service\install.cjs"
  StrCpy $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  StrCpy $2 "$APPDATA\Friction"
  StrCpy $3 "$2\service-install.log"

  IfFileExists "$0" 0 service_install_missing
    ; Use ExecWait with explicit cmd.exe to ensure proper privilege inheritance
    ExecWait '"$SYSDIR\cmd.exe" /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ""$1"" ""$0"" ""--user-data"" ""$2"" ""--exec-path"" ""$1"" ""--log-file"" ""$3"""' $4
    ${If} $4 != 0
      MessageBox MB_ICONSTOP "Friction installed, but the background service could not be registered. Log: $3"
      Abort
    ${EndIf}
    Goto service_install_done

  service_install_missing:
    MessageBox MB_ICONSTOP "Friction service installer was not found: $0"
    Abort

  service_install_done:
!macroend

!macro customUnInstall
  DetailPrint "Uninstalling Friction background service..."

  StrCpy $0 "$INSTDIR\resources\app.asar.unpacked\dist-electron\service\uninstall.cjs"
  StrCpy $1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  StrCpy $2 "$APPDATA\Friction"
  StrCpy $3 "$2\service-uninstall.log"

  IfFileExists "$0" 0 service_uninstall_done
    ; Use ExecWait with explicit cmd.exe to ensure proper privilege inheritance
    ExecWait '"$SYSDIR\cmd.exe" /d /s /c "set ELECTRON_RUN_AS_NODE=1&& ""$1"" ""$0"" ""--user-data"" ""$2"" ""--exec-path"" ""$1"" ""--log-file"" ""$3"""' $4
    ${If} $4 != 0
      MessageBox MB_ICONEXCLAMATION "Friction was removed, but the background service cleanup failed. Log: $3"
    ${EndIf}

  service_uninstall_done:
!macroend
