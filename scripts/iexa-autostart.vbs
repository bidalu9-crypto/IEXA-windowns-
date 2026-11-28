' iExA logon launcher.
'
' The HKCU Run entry written by the in-app switch calls this file instead of
' start.bat: wscript runs with no console at all, while a .bat would flash a
' black window every boot and would also re-run the TypeScript build.
'
' Keep this file pure ASCII. Windows Script Host reads .vbs in the ANSI code
' page, so UTF-8 Chinese in a comment can break parsing.
Option Explicit

Dim shell, fso, appDir, nodeExe, serverJs

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This script lives in <app>\scripts\, so the app root is two levels up.
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
serverJs = appDir & "\dist\main\server.js"
If Not fso.FileExists(serverJs) Then WScript.Quit 1

' start.bat pins the mobile bridge to 443; match it so the phone URL survives.
nodeExe = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\IEXA\runtime\node\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

' A locked-down policy can refuse the environment write. Losing the pin is
' better than an error dialog in the middle of logon, so let it go quietly.
On Error Resume Next
shell.Environment("Process")("IEXA_MOBILE_PORT") = "443"
On Error GoTo 0

shell.CurrentDirectory = appDir
' 0 = hidden window, False = do not wait for it to exit.
shell.Run """" & nodeExe & """ """ & serverJs & """", 0, False
