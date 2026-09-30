Option Explicit
On Error Resume Next
Dim appRef, desc
Set appRef = CreateObject("Photoshop.Application")
Set desc = CreateObject("Photoshop.ActionDescriptor")
If WScript.Arguments.Count > 0 Then
    desc.PutString appRef.StringIDToTypeID("scriptArgs"), WScript.Arguments(0)
End If
appRef.ExecuteAction appRef.StringIDToTypeID("03c3cc32-600d-4e47-ad5c-2b11c0f5f176"), desc, 3
