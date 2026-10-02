' BodyCodi -> GCal Sync : AUTO-UPDATE.ps1 을 창 없이 실행하는 래퍼
' (작업 스케줄러가 10분마다 호출 — 검은 PowerShell 창이 깜빡이지 않도록 함)
Dim sh, fso, dir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\AUTO-UPDATE.ps1""", 0, False
