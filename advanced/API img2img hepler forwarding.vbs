Option Explicit
On Error Resume Next

Dim appRef
Dim desc

Dim WshArguments, i, list, FSO, f, CurrentPath
set WshArguments=WScript.Arguments

Set appRef = CreateObject("Photoshop.Application")
Set desc = CreateObject("Photoshop.ActionDescriptor")
if WshArguments.count()> 0 then
    desc.putString appRef.stringIDToTypeID("args"), "--dialog"
End if
appRef.executeAction appRef.stringIDToTypeID("03c3cc32-600d-4e47-ad5c-2b11c0f5f176"), desc, 3
