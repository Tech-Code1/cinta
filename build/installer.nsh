; Uninstall: take Cinta out of Claude Desktop / Claude Code (not when the uninstaller runs for an update).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-mcp'
  ${endIf}
!macroend
