Attribute VB_Name = "Module1"
' === MACRO 1: ExportarCSV (v15.4 — layout v12) ===
' V15.4 (2026-07-03): FIX carga por Id SH — CSV salía SIN DATOS cuando las filas se
'   identifican por "Id SH" (col C) con "Número de parte" (col E) VACÍO (caso de uso legítimo:
'   actualizar PNs EXISTENTES por su ID de Steelhead, no dar de alta por nombre). Bug: el
'   guard de rango ya contaba Id SH (lastR = max(lastPN, lastID)) y por eso no saltaba
'   "No hay filas de datos", PERO el volcado real filtraba filas SOLO por PN
'   (`If Trim(PN) = "" Then GoTo NextK`) → nOut = 0 → CSV con metadata + header y cero filas.
'   Inconsistencia interna: el rango reconocía Id SH pero la escritura lo ignoraba. Ahora el
'   criterio de "fila con datos" es PN <> "" OR Id SH <> "" en los TRES puntos (conteo nOut,
'   loop de escritura, aviso SOLO_PN > 2000), idéntico al parser downstream
'   (`bulk-upload.js`: `if (!pn && !idShEarly) continue`). Además la clave de orden desempata
'   por Id SH para que las filas solo-IdSH salgan deterministas. Ver §§2, 4, 6 y HasRowData.
' V15.3 (2026-06-18): FIX Mac DEFINITIVO — vuelve a SaveAs nativo (como el legacy v10/v11/v84).
'   Los intentos v15.1/v15.2 fallaron en Mac: ADODB.Stream → "error 429 (ActiveX can't create
'   object)" porque ADODB es COM solo-Windows; y Open ... For Binary → "error 75 (Path/File access
'   error)" porque escribir un archivo NUEVO con I/O de bajo nivel está bloqueado por el SANDBOX
'   de Excel para Mac (ni GetSaveAsFilename ni GrantAccessToMultipleFiles lo habilitan para Open).
'   El método que SIEMPRE funcionó en Mac es SaveAs FileFormat:=62 (xlCSVUTF8): Excel guarda SU
'   PROPIO archivo y el sandbox le concede la ruta elegida en GetSaveAsFilename.
'   Se CONSERVA el build canónico de v15 (expansión de combos), pero en vez de armar el string y
'   escribirlo a mano, se vuelca a un LIBRO TEMPORAL (celdas como texto "@" para preservar punto
'   decimal/ceros/fechas) y se exporta con SaveAs 62. Sin ADODB, sin Open, sin #If, sin sandbox.
'   El parser tolera BOM (lo strippea: bulk-upload.js `replace(/^﻿/,'')`), cualquier fin de
'   línea (parseCSV consume \r/\n/\r\n) y filas cortas (`(row[i]||'')`). Ver secciones 6-8.
' V15 (2026-06-09): reescrito para el spreadsheet v12 (hoja "Upload", 60 cols visibles).
'   Expande 3 columnas combo a la forma que el parser entiende:
'     - "Estatus"          -> "Archivado" + "Validación"            (V/F)
'     - "Forzar duplicado" -> "Forzar" + "Archivar anterior"        (V/F)
'     - "Productos"        -> 3 grupos Producto/Precio/Cantidad/Unidad vía CAT_Productos
'   El resto de columnas pasan 1:1 (encabezado normalizado + valor calculado .Value).
'   "Etiqueta Planta Schneider" -> "Planta Schneider". Headers duplicados (racks) se
'   desambiguan (" 2"). NO exporta Departamento/SAT/UnidadMedidaSAT (el parser los pone
'   por default). Lee .Value (raw) -> ya no hace falta el truco "General" de predictivos.
'   Metadata (modo/empresa/quoteName/notas/asignado/válida) se lee LABEL-DRIVEN (robusto a
'   posiciones) y se re-emite como bloque limpio arriba del CSV.
'   Orden determinista por (Cliente, PN) con quicksort en memoria.
'
' Posiciones de datos v12 (fila 7 = encabezados, datos fila 9+):
'   1=Estatus  2=Forzar duplicado  3=Id SH  4=Cliente  5=Número de parte ...
'
' Columnas de datos clave:
Private Const COL_IDSH As Long = 3
Private Const COL_CLIENTE As Long = 4
Private Const COL_PN As Long = 5
Private Const HEADER_ROW As Long = 7
Private Const DATA_START As Long = 9

Sub ExportarCSV()
    Dim ws As Worksheet
    Set ws = ThisWorkbook.Sheets("Upload")

    ' ── 1) Metadata (label-driven) ──
    Dim modoRaw As String, modoNorm As String
    modoRaw = ScanModo(ws)
    modoNorm = Replace(Replace(UCase(modoRaw), ChrW(211), "O"), " ", "_")
    If modoNorm <> "COTIZACION+NP" And modoNorm <> "SOLO_PN" Then
        MsgBox "Modo inv" & ChrW(225) & "lido: '" & modoRaw & "'." & vbCrLf & _
               "Debe ser 'COTIZACI" & ChrW(211) & "N+NP' o 'SOLO_PN' en la regi" & ChrW(243) & "n superior.", _
               vbCritical, "Modo inv" & ChrW(225) & "lido"
        Exit Sub
    End If
    Dim esCotizacion As Boolean
    esCotizacion = (modoNorm = "COTIZACION+NP")

    Dim empresa As String, quoteName As String, notasExt As String
    Dim notasInt As String, asignado As String, validaDias As String
    empresa = MetaVal(ws, "empresa emisora")
    quoteName = MetaVal(ws, "nombre cotizacion/layout")
    notasExt = MetaVal(ws, "notas externas")
    notasInt = MetaVal(ws, "notas internas")
    asignado = MetaVal(ws, "asignado")
    validaDias = MetaVal(ws, "valida hasta (dias)")

    If esCotizacion And quoteName = "" Then
        MsgBox "Modo COTIZACI" & ChrW(211) & "N+NP requiere 'Nombre Cotizaci" & ChrW(243) & "n/Layout'.", _
               vbCritical, "QuoteName faltante"
        Exit Sub
    End If

    ' ── 2) Rango de datos + validaciones ──
    Dim lastCol As Long, lastR As Long, lastPN As Long, lastID As Long
    lastCol = ws.Cells(HEADER_ROW, ws.Columns.Count).End(xlToLeft).Column
    lastPN = ws.Cells(ws.Rows.Count, COL_PN).End(xlUp).Row
    lastID = ws.Cells(ws.Rows.Count, COL_IDSH).End(xlUp).Row
    lastR = lastPN: If lastID > lastR Then lastR = lastID
    If lastR < DATA_START Then MsgBox "No hay filas de datos.", vbExclamation: Exit Sub

    ' PN sin Cliente
    Dim r As Long, pnVal As String, clVal As String, nFalt As Long, faltMsg As String
    For r = DATA_START To lastR
        pnVal = Trim(CStr(ws.Cells(r, COL_PN).Value))
        If pnVal <> "" Then
            clVal = Trim(CStr(ws.Cells(r, COL_CLIENTE).Value))
            If clVal = "" Or clVal = "(seleccione)" Or clVal = "(seleccione o escriba)" Then
                nFalt = nFalt + 1
                If nFalt <= 10 Then faltMsg = faltMsg & "  Fila " & r & ": " & pnVal & vbCrLf
            End If
        End If
    Next r
    If nFalt > 0 Then
        Dim m1 As String
        m1 = "No se puede exportar: " & nFalt & " l" & ChrW(237) & "nea(s) con PN sin Cliente." & vbCrLf & vbCrLf & faltMsg
        If nFalt > 10 Then m1 = m1 & "  ... y " & (nFalt - 10) & " m" & ChrW(225) & "s" & vbCrLf
        MsgBox m1, vbExclamation, "Cliente faltante": Exit Sub
    End If

    ' Cliente único en COTIZACIÓN+NP
    If esCotizacion Then
        Dim cu As New Collection, ct As String
        For r = DATA_START To lastR
            If Trim(CStr(ws.Cells(r, COL_PN).Value)) <> "" Then
                ct = Trim(CStr(ws.Cells(r, COL_CLIENTE).Value))
                If ct <> "" Then On Error Resume Next: cu.Add ct, ct: On Error GoTo 0
            End If
        Next r
        If cu.Count > 1 Then
            MsgBox "Modo COTIZACI" & ChrW(211) & "N+NP requiere UN SOLO cliente; encontr" & ChrW(233) & " " & _
                   cu.Count & ". Usa SOLO_PN para varios.", vbCritical, "Cliente mixto": Exit Sub
        End If
    End If

    ' Aviso SOLO_PN > 2000
    If Not esCotizacion Then
        Dim nData As Long
        For r = DATA_START To lastR
            ' Fila con datos = PN o Id SH (igual que el volcado §6 y el parser downstream)
            If HasRowData(CStr(ws.Cells(r, COL_PN).Value), CStr(ws.Cells(r, COL_IDSH).Value)) Then nData = nData + 1
        Next r
        If nData > 2000 Then
            If MsgBox(nData & " filas SOLO_PN exceden 2,000 recomendadas." & vbCrLf & _
                      ChrW(191) & "Continuar en un solo CSV?", vbYesNo + vbExclamation, "SOLO_PN grande") <> vbYes Then Exit Sub
        End If
    End If

    ' ── 3) Plan de columnas canónicas (header-driven sobre la fila 7) ──
    Dim outHdr As New Collection, outCol As New Collection, outTyp As New Collection, used As New Collection
    Dim c As Long, hn As String, gi As Long
    For c = 1 To lastCol
        hn = NormHeader(CStr(ws.Cells(HEADER_ROW, c).Value))
        If hn <> "" Then
            Select Case LCase$(hn)
                Case "estatus"
                    AddOut outHdr, outCol, outTyp, used, "Archivado", c, 1
                    AddOut outHdr, outCol, outTyp, used, "Validaci" & ChrW(243) & "n", c, 11
                Case "forzar duplicado"
                    AddOut outHdr, outCol, outTyp, used, "Forzar", c, 2
                    AddOut outHdr, outCol, outTyp, used, "Archivar anterior", c, 21
                Case "productos"
                    For gi = 1 To 3
                        AddOut outHdr, outCol, outTyp, used, "Producto " & gi, c, 100 + (gi - 1) * 4 + 0
                        AddOut outHdr, outCol, outTyp, used, "Precio " & gi, c, 100 + (gi - 1) * 4 + 1
                        AddOut outHdr, outCol, outTyp, used, "Cantidad " & gi, c, 100 + (gi - 1) * 4 + 2
                        AddOut outHdr, outCol, outTyp, used, "Unidad " & gi, c, 100 + (gi - 1) * 4 + 3
                    Next gi
                Case "etiqueta planta schneider"
                    AddOut outHdr, outCol, outTyp, used, "Planta Schneider", c, 0
                Case Else
                    AddOut outHdr, outCol, outTyp, used, hn, c, 0
            End Select
        End If
    Next c

    ' ── 4) Datos a memoria + orden determinista (Cliente, PN) ──
    Dim data As Variant
    data = ws.Range(ws.Cells(DATA_START, 1), ws.Cells(lastR, lastCol)).Value
    Dim n As Long: n = UBound(data, 1)
    Dim idx() As Long, keys() As String, k As Long
    ReDim idx(1 To n): ReDim keys(1 To n)
    For k = 1 To n
        idx(k) = k
        ' Orden por (Cliente, PN); desempate por Id SH para que las filas solo-IdSH
        ' (Cliente y PN vacíos) salgan deterministas en vez de en orden arbitrario.
        keys(k) = UCase(Trim(CStr(data(k, COL_CLIENTE)))) & "|" & _
                  UCase(Trim(CStr(data(k, COL_PN)))) & "|" & Trim(CStr(data(k, COL_IDSH)))
    Next k
    If n >= 2 Then QSortIdx idx, keys, 1, n

    ' ── 5) CAT_Productos a memoria ──
    Dim wsP As Worksheet
    On Error Resume Next: Set wsP = ThisWorkbook.Sheets("CAT_Productos"): On Error GoTo 0
    Dim prodMap As Collection
    Set prodMap = LoadCatProductos(wsP)

    ' ── 6) Construir matriz de salida (metadata + header canónico + filas) ──
    ' Se vuelca a un libro temporal y se exporta con SaveAs FileFormat:=62 (ver §8).
    ' Las celdas van como TEXTO ("@") para preservar punto decimal, ceros a la izquierda y
    ' fechas tal cual; Excel hace el escapado CSV (comas/comillas) — igual semántica que el
    ' viejo CsvQuote, pero nativo y cross-platform. El orden ya viene canonizado (Cliente, PN).
    Dim i As Long, ri As Long, t As Long, col As Long, sv As String, fz As String

    Dim nOut As Long: nOut = 0
    For k = 1 To n
        If HasRowData(CStr(data(idx(k), COL_PN)), CStr(data(idx(k), COL_IDSH))) Then nOut = nOut + 1
    Next k

    Const METAROWS As Long = 7                  ' 1 fila modo + 6 labels de metadata
    Dim nc As Long: nc = outHdr.Count
    Dim totalRows As Long: totalRows = METAROWS + 1 + nOut    ' metadata + header + datos
    Dim outArr() As Variant
    ReDim outArr(1 To totalRows, 1 To nc)

    ' Metadata (col 1 = label / modo, col 2 = valor). Labels ASCII (el parser normaliza acentos).
    outArr(1, 1) = modoRaw
    outArr(2, 1) = "Empresa Emisora:":          outArr(2, 2) = empresa
    outArr(3, 1) = "Nombre Cotizacion/Layout:": outArr(3, 2) = quoteName
    outArr(4, 1) = "Notas Externas:":           outArr(4, 2) = notasExt
    outArr(5, 1) = "Notas Internas:":           outArr(5, 2) = notasInt
    outArr(6, 1) = "Asignado:":                 outArr(6, 2) = asignado
    outArr(7, 1) = "Valida Hasta (dias):":      outArr(7, 2) = validaDias

    ' Header canónico (fila 8)
    For i = 1 To nc
        outArr(METAROWS + 1, i) = CStr(outHdr(i))
    Next i

    ' Filas de datos (desde fila 9), saltando filas sin PN
    Dim outRow As Long: outRow = METAROWS + 1
    For k = 1 To n
        ri = idx(k)
        ' Exportar la fila si tiene PN o Id SH (carga por nombre O por Id de Steelhead)
        If Not HasRowData(CStr(data(ri, COL_PN)), CStr(data(ri, COL_IDSH))) Then GoTo NextK
        outRow = outRow + 1
        For i = 1 To nc
            t = outTyp(i): col = outCol(i)
            Select Case t
                Case 0:  sv = CellToStr(data(ri, col))
                Case 1   ' Archivado (de Estatus). "Dejar como está" -> blanco (tri-state)
                    If InStr(1, CStr(data(ri, col)), "Dejar como", vbTextCompare) > 0 Then
                        sv = ""
                    Else
                        sv = IIf(InStr(1, CStr(data(ri, col)), "Archivado", vbTextCompare) > 0, "V", "F")
                    End If
                Case 11  ' Validación (de Estatus). "Dejar como está" -> blanco
                    If InStr(1, CStr(data(ri, col)), "Dejar como", vbTextCompare) > 0 Then
                        sv = ""
                    Else
                        sv = IIf(InStr(1, CStr(data(ri, col)), "sin validaci", vbTextCompare) > 0, "F", "V")
                    End If
                Case 2
                    fz = CStr(data(ri, col))
                    sv = IIf(InStr(1, fz, "Forzar duplicado", vbTextCompare) > 0 _
                             And InStr(1, fz, "Sin forzar", vbTextCompare) = 0, "V", "F")
                Case 21: sv = IIf(InStr(1, CStr(data(ri, col)), "archivar anterior", vbTextCompare) > 0, "V", "F")
                Case Is >= 100: sv = ProdValue(prodMap, NormKey(CStr(data(ri, col))), t - 100)
            End Select
            outArr(outRow, i) = sv
        Next i
NextK:
    Next k

    ' ── 7) Nombre sugerido + ruta de guardado ──
    Dim baseName As String, savePath As String, inv As Variant, ch As Variant
    If esCotizacion Then
        baseName = quoteName & "-" & Format(Now, "yyyymmdd")
    ElseIf quoteName <> "" Then
        baseName = quoteName & "-solopn-" & Format(Now, "yyyymmdd")
    Else
        baseName = "solopn-" & Format(Now, "yyyymmdd-hhnn")
    End If
    inv = Array("/", "\", ":", "*", "?", Chr(34), "<", ">", "|")
    For Each ch In inv: baseName = Replace(baseName, CStr(ch), "_"): Next
    #If Mac Then
        savePath = Application.GetSaveAsFilename(baseName & ".csv")
    #Else
        savePath = Application.GetSaveAsFilename(baseName & ".csv", "CSV UTF-8 (*.csv), *.csv")
    #End If
    If CStr(savePath) = "False" Or savePath = "" Then Exit Sub
    If LCase(Right(savePath, 4)) <> ".csv" Then savePath = savePath & ".csv"

    ' ── 8) Volcar a libro temporal y exportar como CSV UTF-8 (SaveAs FileFormat:=62) ──
    ' SaveAs es NATIVO de Excel y funciona en Mac y Windows: el sandbox de Mac concede a Excel
    ' la ruta que el usuario eligió en GetSaveAsFilename (a diferencia de Open de bajo nivel,
    ' que el sandbox bloquea → error 75). 62 = xlCSVUTF8 (UTF-8). El parser strippea el BOM.
    Dim prevDA As Boolean, prevSU As Boolean
    prevDA = Application.DisplayAlerts: prevSU = Application.ScreenUpdating
    Application.DisplayAlerts = False: Application.ScreenUpdating = False

    Dim tmpWb As Workbook, tmpWs As Worksheet
    On Error GoTo SaveErr
    Set tmpWb = Workbooks.Add
    Set tmpWs = tmpWb.Sheets(1)
    tmpWs.Cells.NumberFormat = "@"              ' todo texto: preserva 1.18, ceros y fechas tal cual
    tmpWs.Range(tmpWs.Cells(1, 1), tmpWs.Cells(totalRows, nc)).Value = outArr
    tmpWb.SaveAs fileName:=savePath, FileFormat:=62
    tmpWb.Close SaveChanges:=False
    On Error GoTo 0

    Application.DisplayAlerts = prevDA: Application.ScreenUpdating = prevSU

    MsgBox "CSV v12 exportado:" & vbCrLf & savePath & vbCrLf & vbCrLf & _
           "Modo: " & IIf(esCotizacion, "COTIZACI" & ChrW(211) & "N+NP", "SOLO_PN") & vbCrLf & _
           nc & " columnas " & ChrW(183) & " " & nOut & " filas " & ChrW(183) & " ordenado por (Cliente, PN).", _
           vbInformation, "Listo"
    Exit Sub

SaveErr:
    Dim eDesc As String: eDesc = Err.Description
    On Error Resume Next
    If Not tmpWb Is Nothing Then tmpWb.Close SaveChanges:=False
    Application.DisplayAlerts = prevDA: Application.ScreenUpdating = prevSU
    On Error GoTo 0
    MsgBox "No se pudo guardar el CSV:" & vbCrLf & savePath & vbCrLf & vbCrLf & eDesc, _
           vbCritical, "Error al guardar"
End Sub

' ===========================  Helpers  ===========================

' Una fila cuenta como "con datos" si trae Número de parte O Id SH. Mismo criterio que el
' parser downstream (bulk-upload.js: `if (!pn && !idShEarly) continue`). El Id SH identifica
' un PN EXISTENTE en Steelhead, así que una fila solo-IdSH (sin PN) es válida y debe exportarse.
Private Function HasRowData(ByVal pn As String, ByVal idsh As String) As Boolean
    HasRowData = (Trim$(pn) <> "") Or (Trim$(idsh) <> "")
End Function

Private Sub AddOut(h As Collection, oc As Collection, ot As Collection, used As Collection, _
                   ByVal hdr As String, ByVal col As Long, ByVal typ As Long)
    Dim cand As String, k As Long
    cand = hdr: k = 1
    Do While CollHas(used, cand)
        k = k + 1: cand = hdr & " " & k
    Loop
    used.Add cand, cand
    h.Add cand: oc.Add col: ot.Add typ
End Sub

Private Function ScanModo(ws As Worksheet) As String
    Dim r As Long, c As Long, v As String
    For r = 1 To 4
        For c = 1 To 26
            v = Replace(UCase(Trim(CStr(ws.Cells(r, c).Value))), ChrW(211), "O")
            If v = "COTIZACION+NP" Or v = "SOLO_PN" Or v = "SOLO PN" Then
                ScanModo = Trim(CStr(ws.Cells(r, c).Value)): Exit Function
            End If
        Next c
    Next r
    ScanModo = ""
End Function

Private Function MetaVal(ws As Worksheet, ByVal labelKey As String) As String
    ' Busca en filas 1..6 una celda cuyo label (sin acentos, sin ":") == labelKey,
    ' y devuelve el primer valor no vacío a la derecha (1..4) que NO sea otro label.
    Dim r As Long, c As Long, d As Long, nx As String
    For r = 1 To 6
        For c = 1 To 30
            If NormLabel(CStr(ws.Cells(r, c).Value)) = labelKey Then
                For d = 1 To 4
                    nx = Trim(CStr(ws.Cells(r, c + d).Value))
                    If nx <> "" Then
                        If Not IsAnyLabel(NormLabel(nx)) Then MetaVal = nx: Exit Function
                    End If
                Next d
            End If
        Next c
    Next r
    MetaVal = ""
End Function

Private Function IsAnyLabel(ByVal nrm As String) As Boolean
    Select Case nrm
        Case "empresa emisora", "nombre cotizacion/layout", "notas externas", _
             "notas internas", "asignado", "valida hasta (dias)"
            IsAnyLabel = True
        Case Else
            IsAnyLabel = False
    End Select
End Function

Private Function NormLabel(ByVal s As String) As String
    s = LCase(Trim(s))
    If Right(s, 1) = ":" Then s = Left(s, Len(s) - 1)
    s = StripAccents(s)
    Do While InStr(s, "  ") > 0: s = Replace(s, "  ", " "): Loop
    NormLabel = Trim(s)
End Function

Private Function StripAccents(ByVal s As String) As String
    s = Replace(s, ChrW(225), "a"): s = Replace(s, ChrW(233), "e")
    s = Replace(s, ChrW(237), "i"): s = Replace(s, ChrW(243), "o")
    s = Replace(s, ChrW(250), "u"): s = Replace(s, ChrW(241), "n")
    s = Replace(s, ChrW(252), "u")
    StripAccents = s
End Function

Private Function NormHeader(ByVal s As String) As String
    s = Replace(s, vbLf, " "): s = Replace(s, vbCr, " ")
    Do While InStr(s, "  ") > 0: s = Replace(s, "  ", " "): Loop
    NormHeader = Trim$(s)
End Function

Private Function NormKey(ByVal s As String) As String
    s = Trim$(s)
    If s = "(seleccione)" Or s = "-" Then s = ""
    NormKey = s
End Function

Private Function LoadCatProductos(ws As Worksheet) As Collection
    Dim col As New Collection
    If Not ws Is Nothing Then
        Dim last As Long, r As Long, j As Long, key As String, s As String
        last = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
        For r = 2 To last
            key = NormKey(CStr(ws.Cells(r, 1).Value))
            If key <> "" Then
                s = ""
                For j = 0 To 11                       ' cols B..M = Producto1..Unidad3
                    s = s & CellToStr(ws.Cells(r, 2 + j).Value) & Chr(1)
                Next j
                On Error Resume Next: col.Add s, key: On Error GoTo 0
            End If
        Next r
    End If
    Set LoadCatProductos = col
End Function

Private Function ProdValue(map As Collection, ByVal key As String, ByVal idx As Long) As String
    If key = "" Then ProdValue = "": Exit Function
    Dim s As String
    On Error GoTo nf
    s = map(key)
    On Error GoTo 0
    Dim parts() As String
    parts = Split(s, Chr(1))
    If idx >= 0 And idx <= UBound(parts) Then ProdValue = parts(idx) Else ProdValue = ""
    Exit Function
nf:
    ProdValue = ""
End Function

Private Function CellToStr(ByVal v As Variant) As String
    If IsError(v) Then CellToStr = "": Exit Function
    If IsNull(v) Or IsEmpty(v) Then CellToStr = "": Exit Function
    Select Case VarType(v)
        Case vbDouble, vbSingle, vbCurrency, vbDecimal, vbInteger, vbLong, vbByte
            CellToStr = Trim$(Str$(v))               ' punto decimal invariante
        Case vbBoolean
            CellToStr = IIf(v, "V", "F")
        Case vbDate
            CellToStr = Format$(v, "yyyy-mm-dd")
        Case Else
            CellToStr = CStr(v)
    End Select
End Function

Private Function CollHas(c As Collection, ByVal key As String) As Boolean
    Dim v As Variant
    On Error GoTo no
    v = c(key): CollHas = True: Exit Function
no: CollHas = False
End Function

Private Sub QSortIdx(idx() As Long, keys() As String, ByVal lo As Long, ByVal hi As Long)
    Dim i As Long, j As Long, t As Long, p As String
    i = lo: j = hi: p = keys(idx((lo + hi) \ 2))
    Do While i <= j
        Do While StrComp(keys(idx(i)), p, vbTextCompare) < 0: i = i + 1: Loop
        Do While StrComp(keys(idx(j)), p, vbTextCompare) > 0: j = j - 1: Loop
        If i <= j Then
            t = idx(i): idx(i) = idx(j): idx(j) = t
            i = i + 1: j = j - 1
        End If
    Loop
    If lo < j Then QSortIdx idx, keys, lo, j
    If i < hi Then QSortIdx idx, keys, i, hi
End Sub
