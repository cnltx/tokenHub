Option Explicit
Dim shell, fso, root, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
On Error Resume Next
result = shell.Run("node """ & root & "\src\desktop.js"" --docker", 0, True)
If Err.Number <> 0 Or result <> 0 Then
  MsgBox "tokenHub Docker could not start. Start Docker Desktop first. See data\desktop-error.log.", 48, "tokenHub Docker"
End If
