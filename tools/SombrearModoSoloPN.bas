Sub SombrearModoSoloPN()
    ' Sombrea en gris las columnas que NO aplican en modo SOLO_PN
    ' Ejecutar cuando el modo en C3 sea "SOLO_PN"
    ' Las columnas sombreadas: H (Cantidad), I (Precio), J (Unidad Precio),
    ' K (Precio Default), T-AE (Productos x3)

    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Dim modo As String
    modo = UCase(Trim(wsUp.Range("C3").Value))

    Dim grisClaro As Long
    grisClaro = RGB(224, 224, 224)  ' Gris claro para "no aplica"

    Dim verdeClaro As Long
    verdeClaro = RGB(232, 245, 233) ' Verde claro para "editable"

    If InStr(modo, "SOLO") > 0 Then
        ' Modo SOLO_PN: sombrear solo columnas que no aplican
        ' Header: Nombre Cotización, Notas, Válida hasta
        wsUp.Range("A4:D4").Interior.Color = grisClaro
        wsUp.Range("A9:D10").Interior.Color = grisClaro
        wsUp.Range("A12:D12").Interior.Color = grisClaro

        ' Data columns: Productos x3 (S-AD) — no aplican sin cotización
        wsUp.Range("S18:AD300").Interior.Color = grisClaro
        wsUp.Range("S16:AD17").Interior.Color = grisClaro

        ' Precio, Cantidad, Unidad, PrecioDefault (H-K) quedan HABILITADOS para precios standalone

        MsgBox "Modo SOLO_PN: Productos sombreados en gris (no aplican)." & vbCrLf & _
               "Precio y Cantidad habilitados para precios standalone.", vbInformation
    Else
        ' Modo COTIZACION+NP: restaurar colores editables
        wsUp.Range("A4:D4").Interior.Color = verdeClaro
        wsUp.Range("A9:D10").Interior.Color = verdeClaro
        wsUp.Range("A12:D12").Interior.Color = verdeClaro
        wsUp.Range("S18:AD300").Interior.Color = verdeClaro
        wsUp.Range("S16:AD17").Interior.Color = verdeClaro

        MsgBox "Modo COTIZACION+NP: todos los campos habilitados.", vbInformation
    End If
End Sub
