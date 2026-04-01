Attribute VB_Name = "ModuleLimpiar"
' === MACRO: LimpiarDatos ===
' Borra todos los datos de la zona de datos (filas 22+)
' Preserva fórmulas. Deja la plantilla lista para nueva carga.

Sub LimpiarDatos()
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Dim lastRow As Long
    lastRow = wsUp.Cells(wsUp.Rows.Count, 5).End(xlUp).Row
    If lastRow < 22 Then
        MsgBox "No hay datos para limpiar.", vbInformation
        Exit Sub
    End If

    Dim resp As VbMsgBoxResult
    resp = MsgBox("Borrar todos los datos de filas 22 a " & lastRow & "?" & vbCrLf & vbCrLf & _
        "Se borran valores y checkboxes." & vbCrLf & _
        "Las fórmulas se preservan.", vbYesNo + vbExclamation, "LimpiarDatos")
    If resp <> vbYes Then Exit Sub

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    Dim r As Long, c As Long
    Dim cell As Range
    Dim cleaned As Long
    cleaned = 0

    For r = 22 To lastRow
        For c = 1 To 61
            Set cell = wsUp.Cells(r, c)
            If cell.HasFormula Then GoTo NextCell
            If Not IsEmpty(cell.Value) Then
                cell.ClearContents
                cleaned = cleaned + 1
            End If
NextCell:
        Next c
    Next r

    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    MsgBox cleaned & " celdas borradas. Plantilla lista para nueva carga.", vbInformation, "LimpiarDatos"
End Sub

' === MACRO: LimpiarEspacios ===
' Limpia espacios iniciales, finales y dobles en celdas de texto.
' NO borra datos ni toca fórmulas.

Sub LimpiarEspacios()
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    Dim lastRow As Long
    lastRow = wsUp.Cells(wsUp.Rows.Count, 5).End(xlUp).Row
    If lastRow < 22 Then lastRow = 22

    Dim r As Long, c As Long
    Dim cell As Range
    Dim cleaned As Long
    cleaned = 0

    For r = 22 To lastRow
        For c = 1 To 61
            Set cell = wsUp.Cells(r, c)
            If cell.HasFormula Then GoTo NextCell2
            If IsEmpty(cell.Value) Then GoTo NextCell2
            If IsNumeric(cell.Value) And Not VarType(cell.Value) = vbString Then GoTo NextCell2
            If VarType(cell.Value) = vbBoolean Then GoTo NextCell2

            Dim original As String, limpio As String
            original = CStr(cell.Value)
            limpio = Trim(original)
            Do While InStr(limpio, "  ") > 0
                limpio = Replace(limpio, "  ", " ")
            Loop
            If limpio <> original Then
                cell.Value = limpio
                cleaned = cleaned + 1
            End If
NextCell2:
        Next c
    Next r

    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    MsgBox cleaned & " celdas limpiadas (espacios).", vbInformation, "LimpiarEspacios"
End Sub
