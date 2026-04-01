Sub SombrearModoSoloPN()
    ' Sombrea en gris las columnas que NO aplican según el modo
    ' Se ejecuta automáticamente al cambiar C3

    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Dim modo As String
    modo = UCase(Trim(wsUp.Range("C3").Value))

    Dim grisClaro As Long
    grisClaro = RGB(224, 224, 224)

    Dim verdeClaro As Long
    verdeClaro = RGB(232, 245, 233)

    ' Primero restaurar TODO a verde (reset completo)
    ' Header filas 4-12
    wsUp.Range("A4:D12").Interior.Color = verdeClaro
    ' Datos: Precio/Cantidad (H-K) y Productos (S-AD)
    wsUp.Range("H16:K300").Interior.Color = verdeClaro
    wsUp.Range("S16:AD300").Interior.Color = verdeClaro

    If InStr(modo, "SOLO") > 0 Then
        ' Modo SOLO_PN: sombrear lo que NO aplica
        ' Header: Nombre Cotización (4), Notas (9-10), Válida hasta (12)
        wsUp.Range("A4:D4").Interior.Color = grisClaro
        wsUp.Range("A9:D10").Interior.Color = grisClaro
        wsUp.Range("A12:D12").Interior.Color = grisClaro

        ' Productos x3 (S-AD) — no aplican sin cotización
        wsUp.Range("S16:AD300").Interior.Color = grisClaro

        ' Precio (H-K) queda HABILITADO para precios standalone

        MsgBox "Modo SOLO_PN:" & vbCrLf & _
               "- Productos sombreados (no aplican)" & vbCrLf & _
               "- Precio y Cantidad habilitados (precios standalone)", vbInformation
    Else
        ' Modo COTIZACIÓN+NP: todo verde (ya se restauró arriba)
        MsgBox "Modo COTIZACIÓN+NP: todos los campos habilitados.", vbInformation
    End If
End Sub
