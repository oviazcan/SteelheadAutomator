Attribute VB_Name = "ModuleLimpiar"
' === MACRO: LimpiarDatos ===
' Limpia espacios iniciales, finales y dobles espacios internos
' en todas las celdas de texto de la zona de datos (filas 22+)
' NO toca fórmulas, números ni booleanos

Sub LimpiarDatos()
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    Dim lastRow As Long, lastCol As Long
    lastRow = wsUp.Cells(wsUp.Rows.Count, 5).End(xlUp).Row ' col E = PN
    If lastRow < 22 Then lastRow = 22
    lastCol = 61 ' BI = col 61

    Dim r As Long, c As Long
    Dim cell As Range
    Dim cleaned As Long
    cleaned = 0

    For r = 22 To lastRow
        For c = 1 To lastCol
            Set cell = wsUp.Cells(r, c)

            ' Saltar fórmulas
            If cell.HasFormula Then GoTo NextCell

            ' Saltar vacías
            If IsEmpty(cell.Value) Then GoTo NextCell

            ' Saltar números y booleanos
            If IsNumeric(cell.Value) And Not VarType(cell.Value) = vbString Then GoTo NextCell
            If VarType(cell.Value) = vbBoolean Then GoTo NextCell

            ' Limpiar texto
            Dim original As String
            Dim limpio As String
            original = CStr(cell.Value)
            limpio = Trim(original)

            ' Quitar dobles espacios internos
            Do While InStr(limpio, "  ") > 0
                limpio = Replace(limpio, "  ", " ")
            Loop

            If limpio <> original Then
                cell.Value = limpio
                cleaned = cleaned + 1
            End If
NextCell:
        Next c
    Next r

    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    MsgBox cleaned & " celdas limpiadas (espacios iniciales, finales y dobles).", vbInformation, "LimpiarDatos"
End Sub
