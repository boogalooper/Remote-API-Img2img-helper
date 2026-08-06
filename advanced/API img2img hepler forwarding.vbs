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
appRef.executeAction appRef.stringIDToTypeID("7ddf5f38-fb8c-4c0a-91c7-0d39b6f0c1a4"), desc, 3
