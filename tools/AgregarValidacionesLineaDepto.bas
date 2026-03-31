Sub AgregarValidacionesLineaDepto()
    ' Ejecutar una vez para agregar dropdowns de Línea y Departamento
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    ' Línea dropdown (AW22:AW522)
    With wsUp.Range("AW22:AW522").Validation
        .Delete
        .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
            Formula1:="=Listas!$L$2:$L$27"
        .ShowInput = True
        .ShowError = False
    End With

    ' Departamento dropdown (AX22:AX522)
    With wsUp.Range("AX22:AX522").Validation
        .Delete
        .Add Type:=xlValidateList, AlertStyle:=xlValidAlertStop, _
            Formula1:="=Listas!$M$2:$M$22"
        .ShowInput = True
        .ShowError = False
    End With

    MsgBox "Validaciones de Línea y Departamento agregadas.", vbInformation
End Sub
