; Extra installer/uninstaller behaviour for Fumo Clip (included by electron-builder).
;
; The uninstaller only ever removes the app's own program folder. It never touches your
; clips/videos (they live in your OBS / library folder), and it keeps your settings.
; This adds a clear message so nobody worries about losing their videos.

!include "FileFunc.nsh"

!macro customUnInit
  ; Stay quiet when the uninstaller is run by an auto-update, in silent mode,
  ; or after you already confirmed inside Fumo Clip (Settings > Uninstall).
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "--updated" $R1
  IfErrors 0 fumo_skip_msg
  ClearErrors
  ${GetOptions} $R0 "--fumo-confirmed" $R1
  IfErrors 0 fumo_skip_msg
  IfSilent fumo_skip_msg
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "This removes the Fumo Clip app.$\r$\n$\r$\nYour clips and videos are NOT deleted. They stay in your clips folder, together with their favourites, trims, markers and categories.$\r$\n$\r$\nContinue uninstalling?" IDOK fumo_skip_msg
  Quit
  fumo_skip_msg:
!macroend
