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
        ' Modo SOLO_PN: sombrear columnas que no aplican
        ' Header rows 4 (Nombre Cotizacion), 10-11 (Divisa, Empresa), 13-14 (Notas), 16 (Valida hasta)
        wsUp.Range("A4:D4").Interior.Color = grisClaro
        wsUp.Range("A10:D11").Interior.Color = grisClaro
        wsUp.Range("A13:D14").Interior.Color = grisClaro
        wsUp.Range("A16:D16").Interior.Color = grisClaro

        ' Data columns: H-K (Cantidad, Precio, Unidad, PrecioDefault)
        wsUp.Range("H22:K522").Interior.Color = grisClaro
        wsUp.Range("H20:K21").Interior.Color = grisClaro

        ' Data columns: T-AE (Productos x3)
        wsUp.Range("T22:AE522").Interior.Color = grisClaro
        wsUp.Range("T20:AE21").Interior.Color = grisClaro

        MsgBox "Modo SOLO_PN: columnas de cotizacion sombreadas en gris." & vbCrLf & _
               "No llenar: Cantidad, Precio, Unidad Precio, Precio Default, Productos.", vbInformation
    Else
        ' Modo COTIZACION+NP: restaurar colores editables
        wsUp.Range("A4:D4").Interior.Color = verdeClaro
        wsUp.Range("A10:D11").Interior.Color = verdeClaro
        wsUp.Range("A13:D14").Interior.Color = verdeClaro
        wsUp.Range("A16:D16").Interior.Color = verdeClaro
        wsUp.Range("H22:K522").Interior.Color = verdeClaro
        wsUp.Range("H20:K21").Interior.Color = verdeClaro
        wsUp.Range("T22:AE522").Interior.Color = verdeClaro
        wsUp.Range("T20:AE21").Interior.Color = verdeClaro

        MsgBox "Modo COTIZACION+NP: todos los campos habilitados.", vbInformation
    End If
End Sub
