Attribute VB_Name = "Module5"
' === MACRO: LimpiarDatos (v19 — layout v13) ===
' Borra datos de zona de datos (filas 9+) y restaura defaults / placeholders.
' Preserva fórmulas (HasFormula skip → Planta Schneider, Proceso, Esp.Spec, Longitud, predictivos).
'
' V19 (2026-08-03): CORRIGE EL TOPE del v18. La plantilla v13 final trae una columna MÁS de
'   la que el v18 supuso: "Instrucciones de Empaque" (60=BH), agregada después de los racks,
'   así que la hoja mide 67 columnas (A..BO) y no 66. Con el tope en 66, la ÚLTIMA columna
'   (67=BO Tiempo de Entrega) nunca se limpiaba: conservaba el valor de la carga anterior y se
'   volvía a subir en la siguiente, con la plantilla viéndose limpia. Los 3 loops pasan a 67.
'   Los índices de placeholders NO cambian: phCols/phHybridCols/boolCols apuntan todos a
'   columnas <= 45, o sea ANTES de la columna nueva. Instrucciones de Empaque es texto libre
'   (como Notas adicionales): se limpia y se queda vacía, sin placeholder ni fórmula.
'   LECCIÓN: este módulo se rompe cada vez que la hoja cambia de ancho, y en silencio. El tope
'   está atado a la plantilla real por tools/test/module5-column-cap.test.js — si vuelven a
'   insertar una columna, ese test se pone rojo en vez de que lo descubra el piso.
'
' V18 (2026-08-03): adaptado al layout v13 (5 pares de rack). El layout v13 agrega
'   3 pares de rack (Rack 3/4/5 + sus Pzas) DESPUÉS del par 2, lo que corre +6 todo lo
'   posterior. Este módulo NO se auto-ajusta al insertar columnas en Excel porque
'   referencia columnas por ÍNDICE NUMÉRICO — de ahí que haya que tocarlo a mano:
'     - "For c = 1 To 60" → "1 To 67" (3 lugares: limpieza, restauración de fórmulas y
'       LimpiarEspacios). Sin esto las últimas columnas (Empaque..Tiempo de Entrega se
'       corrieron a 60..67) NUNCA se limpian → datos de la carga anterior sobreviven a
'       LimpiarDatos y se re-suben en la siguiente. Es el modo de falla más caro de los
'       cuatro porque no se ve: la plantilla "se ve limpia".
'     - phCols suma los 3 racks nuevos (39, 41, 43) para que reciban "(seleccione)".
'     - phHybridCols: Tipo de Geometría pasó de 39 a 45. Si no se actualiza, el
'       placeholder "(seleccione o escriba)" se escribiría DENTRO de la columna Rack 3
'       (que en v13 ocupa el índice 39) y Tipo de Geometría se quedaría sin placeholder.
'   boolCols (13 = Precio default) y el chequeo de Proceso (col 21) NO cambian: ambos
'   viven ANTES de los racks. Module1 (ExportarCSV), Module2, Module4 y Hoja1.cls tampoco
'   requieren cambios — sus columnas son todas < 39 o son header-driven.
'
' V17 (2026-06-12): restaura TODAS las columnas calculadas (no solo Proceso) copiándolas
'   desde la FILA MODELO (lastRow). Genérico: detecta qué columnas tienen fórmula ahí y las
'   re-crea con xlPasteFormulas (preserva matriciales/CSE; Excel ajusta refs relativas). El
'   MISMO Module5 sirve para la plantilla moderna (Proceso con FILTER) y la de compatibilidad
'   Excel 2019 (Proceso con SUMAPRODUCTO): copia la fórmula que exista, sea cual sea.
' V16 (2026-06-11): swap correcto de placeholders Cliente/Grupo:
'   - Cliente (col 4 = D): dropdown PURO "(seleccione)".
'   - Grupo (col 8 = H): híbrido "(seleccione o escriba)".
' V15 (2026-06-11): Cantidad (col 9 = I): default = 1 constante.
' V14 (2026-06-11): adaptado al layout v12 (60 cols A..BH).
'
' V13 LAYOUT (67 columnas, A..BO; tipo entre paréntesis). Lo NUEVO vs v12 son las
' columnas 39..44 (Rack 3..5 + sus piezas); de 45 en adelante todo es v12 corrido +6:
'   1=A  Estatus (Combo)          2=B  Forzar duplicado (Combo)
'   3=C  Id SH (Texto)            4=D  Cliente (Drop → "(seleccione)")
'   5=E  Número de parte (Texto)  6=F  Descripción (Texto)
'   7=G  PN alterno (Texto)       8=H  Grupo (Híbrido → "(seleccione o escriba)")
'   9=I  Cantidad (# = 1)        10=J  Precio ($)
'  11=K  Unidad precio (Drop)    12=L  Divisa (Drop, USD)
'  13=M  Precio default (V/F)    14=N  Línea (Drop)
'  15=O  Metal base (Híbrido)    16=P  Etiqueta 1 (Drop)  17=Q Etiqueta 2  18=R Etiqueta 3  19=S Etiqueta 4
'  20=T  Planta Schneider (Calc) 21=U  Proceso (Fórmula)
'  22=V  Productos (Drop)
'  23=W  Spec 1 (Drop)           24=X  Esp.Spec1 (Calc)   25=Y Spec2  26=Z Esp2  27=AA Spec3  28=AB Esp3  29=AC Spec4  30=AD Esp4
'  31=AE KGM (#)  32=AF CMK (#)  33=AG LM (#)  34=AH Mín Pzas Lote (#)
'  35=AI Rack 1 (Drop)  36=AJ Pzas Rack 1 (#)
'  37=AK Rack 2 (Drop)  38=AL Pzas Rack 2 (#)
'  39=AM Rack 3 (Drop)  40=AN Pzas Rack 3 (#)      ← NUEVO en v13
'  41=AO Rack 4 (Drop)  42=AP Pzas Rack 4 (#)      ← NUEVO en v13
'  43=AQ Rack 5 (Drop)  44=AR Pzas Rack 5 (#)      ← NUEVO en v13
'  45=AS Tipo de Geometría (Híbrido)
'  46=AT Longitud (Calc)  47=AU Ancho (#)  48=AV Alto (#)  49=AW Diám.Ext (#)  50=AX Diám.Int (#)
'  51=AY Plata..59=BG Epóx.MTR (Calc, predictivos)
'  60=BH Instrucciones de Empaque (Texto)       <- NUEVA en v13
'  61=BI Notas adicionales (Texto)  62=BJ QuoteIBMS  63=BK EstIBMS  64=BL Plano
'  65=BM Piezas por Carga  66=BN Cargas por Hora  67=BO Tiempo de Entrega
'
' Target: spreadsheet v13 layout, 67 cols A..BO, datos fila 9+

Sub LimpiarDatos()
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Dim lastRow As Long, lastPN As Long, lastID As Long
    lastPN = wsUp.Cells(wsUp.Rows.Count, 5).End(xlUp).Row  ' col E = Número de parte
    lastID = wsUp.Cells(wsUp.Rows.Count, 3).End(xlUp).Row  ' col C = Id SH
    lastRow = lastPN
    If lastID > lastRow Then lastRow = lastID
    If lastRow < 508 Then lastRow = 508

    Dim resp As VbMsgBoxResult
    resp = MsgBox("Borrar todos los datos de filas 9 a " & lastRow & "?" & vbCrLf & vbCrLf & _
        "Se borran valores y checkboxes." & vbCrLf & _
        "Las f" & ChrW(243) & "rmulas se preservan.", vbYesNo + vbExclamation, "LimpiarDatos")
    If resp <> vbYes Then Exit Sub

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    Dim r As Long, c As Long
    Dim cell As Range
    Dim cleaned As Long
    cleaned = 0

    ' V12/V13 bool V/F: solo col 13 (Precio default).
    Dim boolCols As Variant
    boolCols = Array(13)
    ' V12/V13: ya NO hay columnas a preservar (Departamento/SAT eliminados).
    ' (Si en el futuro vuelven, agregar sus índices aquí.)

    For r = 9 To lastRow
        For c = 1 To 67                       ' V13: 67 cols (antes 60)
            Set cell = wsUp.Cells(r, c)
            If cell.HasFormula Then GoTo NextCell

            Dim isBool As Boolean
            isBool = False
            Dim bc As Variant
            For Each bc In boolCols
                If c = CLng(bc) Then isBool = True: Exit For
            Next bc

            If isBool Then
                cell.Value = "V"           ' Precio default = V por defecto
                cleaned = cleaned + 1
            ElseIf Not IsEmpty(cell.Value) Then
                cell.ClearContents
                cleaned = cleaned + 1
            End If
NextCell:
        Next c
    Next r

    ' Restaurar defaults y placeholders
    Dim phSelect As String, phHybrid As String
    phSelect = "(seleccione)"
    phHybrid = "(seleccione o escriba)"

    ' Dropdown puro → "(seleccione)":
    '   4 Cliente | 11 Unid Precio | 14 Línea | 16-19 Etiq1-4 | 22 Productos
    '   23 Spec1 | 25 Spec2 | 27 Spec3 | 29 Spec4
    '   35 Rack 1 | 37 Rack 2 | 39 Rack 3 | 41 Rack 4 | 43 Rack 5   ← V13: +39, +41, +43
    Dim phCols As Variant
    phCols = Array(4, 11, 14, 16, 17, 18, 19, 22, 23, 25, 27, 29, 35, 37, 39, 41, 43)
    ' Híbridas → "(seleccione o escriba)": 8 Grupo | 15 Metal base | 45 Tipo de Geometría
    ' V13: Tipo de Geometría pasó de 39 a 45 (los 3 pares de rack nuevos la empujaron).
    Dim phHybridCols As Variant
    phHybridCols = Array(8, 15, 45)

    Dim phc As Variant
    For r = 9 To lastRow
        ' Defaults especiales de los combos de parámetros + Divisa + Cantidad
        SetIfEmpty wsUp.Cells(r, 1), "Activo con validaci" & ChrW(243) & "n"  ' Estatus
        SetIfEmpty wsUp.Cells(r, 2), "Sin forzar duplicado"                    ' Forzar duplicado
        SetIfEmpty wsUp.Cells(r, 12), "USD"                                    ' Divisa
        ' Cantidad (col 9 = I): 1 constante. Forzado (no SetIfEmpty) salvo fórmula.
        If Not wsUp.Cells(r, 9).HasFormula Then wsUp.Cells(r, 9).Value = 1

        For Each phc In phCols
            SetIfEmpty wsUp.Cells(r, CLng(phc)), phSelect
        Next phc
        For Each phc In phHybridCols
            SetIfEmpty wsUp.Cells(r, CLng(phc)), phHybrid
        Next phc
    Next r

    ' Restaurar TODAS las fórmulas calculadas (Proceso col 21=U, Esp.Spec 24/26/28/30,
    ' predictivos 51..59, Planta Schneider 20, etc.) copiándolas desde la FILA MODELO
    ' (lastRow, normalmente 508 — casi nunca se toca a mano). Genérico: detecta qué columnas
    ' tienen fórmula en la fila modelo y restaura esas hacia toda la zona de datos.
    ' xlPasteFormulas preserva el estado MATRICIAL (CSE) y Excel ajusta las refs relativas.
    Const DATA_START_ROW As Long = 9
    Dim restoredCols As Long, procHadFormula As Boolean
    restoredCols = 0: procHadFormula = False
    For c = 1 To 67                           ' V13: 67 cols (antes 60)
        Set cell = wsUp.Cells(lastRow, c)
        If cell.HasFormula Then
            cell.Copy
            wsUp.Range(wsUp.Cells(DATA_START_ROW, c), wsUp.Cells(lastRow, c)) _
                .PasteSpecial Paste:=xlPasteFormulas
            restoredCols = restoredCols + 1
            If c = 21 Then procHadFormula = True
        End If
    Next c
    Application.CutCopyMode = False
    cleaned = cleaned + restoredCols * (lastRow - DATA_START_ROW + 1)
    If Not procHadFormula Then
        MsgBox "No se encontr" & ChrW(243) & " f" & ChrW(243) & "rmula de Proceso en U" & lastRow & _
               ". C" & ChrW(243) & "piala de otra fila a U" & lastRow & " y vuelve a correr LimpiarDatos.", _
               vbExclamation, "Proceso sin f" & ChrW(243) & "rmula"
    End If

    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    MsgBox cleaned & " celdas procesadas." & vbCrLf & _
        "Estatus=Activo con validaci" & ChrW(243) & "n, Forzar=Sin forzar duplicado." & vbCrLf & _
        "Precio Default = V. Divisa = USD. Cantidad = 1." & vbCrLf & _
        "Placeholders restaurados (Cliente=(seleccione), Grupo=(seleccione o escriba))." & vbCrLf & _
        restoredCols & " columnas calculadas restauradas (Proceso, Esp.Spec, predictivos, ...)." & vbCrLf & _
        "Plantilla lista para nueva carga.", vbInformation, "LimpiarDatos"
End Sub

' Helper: setea un default solo si la celda está vacía y no tiene fórmula.
Private Sub SetIfEmpty(ByVal cell As Range, ByVal val As String)
    If cell.HasFormula Then Exit Sub
    If IsEmpty(cell.Value) Or cell.Value = "" Then cell.Value = val
End Sub

' === MACRO: LimpiarEspacios (v15 — layout v13) ===
' Limpia espacios iniciales, finales y dobles en celdas de texto. NO borra datos ni toca fórmulas.
'
' V15 (2026-08-03): tope 1..67 (el v14 decía 66 y dejaba fuera Tiempo de Entrega).
' V14 (2026-08-03): layout v13 → loop 1..66 (antes 1..60). Sin esto, las últimas columnas
'   (Notas adicionales..Tiempo de Entrega) quedarían fuera de la limpieza de espacios.
' V13 (2026-06-11): layout v12. lastRow por PN col 5 e Id SH col 3. Loop 1..60.
' V12: lastRow por col G/E. V11: loop 1..71.

Sub LimpiarEspacios()
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    Dim lastRow As Long, lastPN As Long, lastID As Long
    lastPN = wsUp.Cells(wsUp.Rows.Count, 5).End(xlUp).Row  ' col E = PN
    lastID = wsUp.Cells(wsUp.Rows.Count, 3).End(xlUp).Row  ' col C = Id SH
    lastRow = lastPN
    If lastID > lastRow Then lastRow = lastID
    If lastRow < 9 Then lastRow = 22

    Dim r As Long, c As Long
    Dim cell As Range
    Dim cleaned As Long
    cleaned = 0

    For r = 9 To lastRow
        For c = 1 To 67                       ' V13: 67 cols (antes 60)
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
