Sub InsertarCheckboxes()
    ' Convierte columnas booleanas a checkboxes in-cell (Excel 365+)
    ' Columnas: A (Archivado), B (Validación), C (Forzar dup), D (Archivar ant), K (Precio default)

    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Dim cols As Variant
    cols = Array("A", "B", "C", "D", "K")

    Dim col As Variant
    For Each col In cols
        Dim rng As Range
        Set rng = wsUp.Range(col & "22:" & col & "522")

        ' Insertar checkboxes in-cell
        On Error Resume Next
        rng.InsertCheckBoxes
        On Error GoTo 0
    Next col

    MsgBox "Checkboxes insertados en columnas A, B, C, D y K.", vbInformation
End Sub
