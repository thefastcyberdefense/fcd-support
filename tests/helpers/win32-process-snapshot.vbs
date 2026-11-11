Option Explicit

Function IsPositiveDigits(value)
  Dim idx, ch
  If Len(value) = 0 Or Len(value) > 9 Then
    IsPositiveDigits = False
    Exit Function
  End If
  For idx = 1 To Len(value)
    ch = Mid(value, idx, 1)
    If ch < "0" Or ch > "9" Then
      IsPositiveDigits = False
      Exit Function
    End If
  Next
  IsPositiveDigits = CLng(value) > 0
End Function

Dim wmi, items, item, i, arg, clauses, query
Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
clauses = ""
For i = 0 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If IsPositiveDigits(arg) Then
    If Len(clauses) > 0 Then clauses = clauses & " OR "
    clauses = clauses & "ProcessId=" & arg & " OR ParentProcessId=" & arg
  End If
Next
If Len(clauses) > 0 Then
  query = "SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process WHERE " & clauses
Else
  query = "SELECT ProcessId, ParentProcessId, CreationDate FROM Win32_Process"
End If
Set items = wmi.ExecQuery(query)
For Each item In items
  If Not IsNull(item.ProcessId) And Not IsNull(item.ParentProcessId) And Not IsNull(item.CreationDate) Then
    WScript.Echo item.ProcessId & "," & item.ParentProcessId & "," & item.CreationDate
  End If
Next
