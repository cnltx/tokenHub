Option Explicit
Dim shell, fso, root, result, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
On Error Resume Next
command = "node """ & root & "\src\desktop.js"""
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--no-open" Then command = command & " --no-open"
End If
result = shell.Run(command, 0, True)
If Err.Number <> 0 Or result <> 0 Then
  MsgBox "tokenHub could not start. Node.js 22+ is required. See data\desktop-error.log.", 48, "tokenHub"
End If
