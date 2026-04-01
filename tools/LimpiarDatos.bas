Attribute VB_Name = "ModuleLimpiar"
' === MACRO: LimpiarDatos ===
' Borra todos los datos de la zona de datos (filas 22+)
' Preserva fórmulas. Deja la plantilla lista para nueva carga.

Sub LimpiarDatos()
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Dim lastRow As Long
    lastRow = wsUp.Cells(wsUp.Rows.Count, 5).End(xlUp).Row
    If lastRow < 18 Then
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

    ' Columnas de checkboxes: A=1(Archivado), B=2(Validación), C=3(Forzar), D=4(Archivar), K=11(PrecioDefault)
    Dim boolCols As Variant
    boolCols = Array(1, 2, 3, 4, 11)
    ' Columnas que no se borran (preservar valor default): AX=50(Código SAT)
    Dim preserveCols As Variant
    preserveCols = Array(50)

    For r = 18 To lastRow
        For c = 1 To 67
            Set cell = wsUp.Cells(r, c)
            If cell.HasFormula Then GoTo NextCell

            ' Checkboxes: poner defaults en vez de borrar
            Dim isBool As Boolean
            isBool = False
            Dim bc As Variant
            For Each bc In boolCols
                If c = CLng(bc) Then isBool = True: Exit For
            Next bc

            ' Columnas preservadas: no tocar
            Dim isPreserve As Boolean
            isPreserve = False
            Dim pc As Variant
            For Each pc In preserveCols
                If c = CLng(pc) Then isPreserve = True: Exit For
            Next pc
            If isPreserve Then GoTo NextCell

            If isBool Then
                ' Defaults: Validación(2)=TRUE, PrecioDefault(11)=TRUE, resto=FALSE
                If c = 2 Or c = 11 Then
                    cell.Value = True
                Else
                    cell.Value = False
                End If
                cleaned = cleaned + 1
            ElseIf Not IsEmpty(cell.Value) Then
                cell.ClearContents
                cleaned = cleaned + 1
            End If
NextCell:
        Next c
    Next r

    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    MsgBox cleaned & " celdas procesadas." & vbCrLf & _
        "Checkboxes: Validación y Precio Default = SI, resto = NO." & vbCrLf & _
        "Plantilla lista para nueva carga.", vbInformation, "LimpiarDatos"
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
    If lastRow < 18 Then lastRow = 22

    Dim r As Long, c As Long
    Dim cell As Range
    Dim cleaned As Long
    cleaned = 0

    For r = 18 To lastRow
        For c = 1 To 67
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
