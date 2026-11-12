' Starts Jarvin. The build runs hidden; the app window itself opens normally.
' Progress is written to jarvin-launch.log in the project folder.
Option Explicit
Dim sh, fso, root, log, rc, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set log = fso.CreateTextFile(root & "\jarvin-launch.log", True)
log.WriteLine Now & "  start, folder " & root
On Error Resume Next
sh.CurrentDirectory = root
log.WriteLine "cd error: " & Err.Number & " " & Err.Description: Err.Clear
' First run after a voice update: install both the fast and accurate local speech engines.
If Not fso.FileExists(root & "\node_modules\@huggingface\transformers\package.json") Or Not fso.FileExists(root & "\node_modules\sherpa-onnx-node\package.json") Or Not fso.FileExists(root & "\node_modules\sherpa-onnx-win-x64\package.json") Then
  sh.Popup "Installing Jarvin's local voice engines (one time). Jarvin opens when it is done.", 8, "Jarvin", 64
  rc = sh.Run("cmd /c npm install --no-audit --no-fund --ignore-scripts > install.log 2>&1", 0, True)
  log.WriteLine "npm install exit: " & rc & " error: " & Err.Number & " " & Err.Description: Err.Clear
  If rc <> 0 Then
    log.Close
    MsgBox "Jarvin could not install its voice engines. See install.log in " & root, 48, "Jarvin"
    WScript.Quit 1
  End If
End If
rc = sh.Run("cmd /c node build.mjs > build.log 2>&1", 0, True)
log.WriteLine "build exit: " & rc & " error: " & Err.Number & " " & Err.Description: Err.Clear
If rc <> 0 Then
  log.Close
  MsgBox "Jarvin could not build. See build.log in " & root, 48, "Jarvin"
  WScript.Quit 1
End If
exe = root & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(exe) Then
  log.WriteLine "electron.exe missing"
  log.Close
  MsgBox "Electron is not installed. Open a terminal in " & root & " and run: npm install", 48, "Jarvin"
  WScript.Quit 1
End If
sh.Run """" & exe & """ .", 1, False
log.WriteLine "electron started, error: " & Err.Number & " " & Err.Description
log.Close
