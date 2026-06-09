Attribute VB_Name = "ExportarCSV_v12"
Option Explicit

' ============================================================================
'  ExportarCSV v12  —  Plantilla_CargaMasiva
' ----------------------------------------------------------------------------
'  Exporta la hoja "Upload" a un CSV CANÓNICO para el parser de la extensión.
'
'  Recorre las columnas visibles (fila 7 = encabezados, datos desde fila 9) y
'  SOLO transforma 3 columnas, identificándolas por NOMBRE de encabezado:
'     - "Estatus"          -> 2 columnas bool: "Archivado", "Validación"
'     - "Forzar duplicado" -> 2 columnas bool: "Forzar", "Archivar anterior"
'     - "Productos"        -> 3 grupos (Producto/Precio/Cantidad/Unidad)
'                             resueltos por VLOOKUP a la hoja CAT_Productos
'  Además:
'     - "Etiqueta Planta Schneider" se renombra a "Planta Schneider".
'     - Encabezados duplicados (p.ej. los 2 "Rack Flybar o Barril (Carga)")
'       se desambiguan agregando " 2", " 3"… para que el parser header-driven
'       no se confunda.
'  El resto de columnas pasan 1:1 (encabezado normalizado + valor calculado).
'
'  NO se exportan Departamento / Clave SAT / UnidadMedidaSAT: el parser los
'  rellena por default desde config.json (solo si el PN no tiene ya valor).
'
'  Salida: CSV UTF-8 (sin BOM), con comillas CSV estándar.
'  Cross-platform: no usa Scripting.Dictionary (Windows-only); usa Collection.
' ============================================================================

Private Const SHEET_UPLOAD As String = "Upload"
Private Const SHEET_CATPROD As String = "CAT_Productos"
Private Const HEADER_ROW As Long = 7
Private Const DATA_START As Long = 9

Public Sub ExportarCSV_v12()
    Dim wsU As Worksheet, wsP As Worksheet
    On Error Resume Next
    Set wsU = ThisWorkbook.Worksheets(SHEET_UPLOAD)
    Set wsP = ThisWorkbook.Worksheets(SHEET_CATPROD)
    On Error GoTo 0
    If wsU Is Nothing Then MsgBox "No existe la hoja '" & SHEET_UPLOAD & "'.", vbExclamation: Exit Sub

    ' --- delimitar columnas y filas ---
    Dim lastCol As Long, lastRow As Long, pnCol As Long
    lastCol = wsU.Cells(HEADER_ROW, wsU.Columns.Count).End(xlToLeft).Column
    pnCol = ColByHeader(wsU, "Número de parte", lastCol)
    If pnCol = 0 Then pnCol = ColByHeader(wsU, "Numero de parte", lastCol)
    If pnCol = 0 Then MsgBox "No encuentro la columna 'Número de parte'.", vbExclamation: Exit Sub
    lastRow = wsU.Cells(wsU.Rows.Count, pnCol).End(xlUp).Row
    If lastRow < DATA_START Then MsgBox "No hay filas de datos.", vbExclamation: Exit Sub

    ' --- catálogo de productos en memoria (key -> 12 campos unidos por Chr(1)) ---
    Dim prodMap As Collection
    Set prodMap = LoadCatProductos(wsP)

    ' --- plan de columnas de salida ---
    '     planType: 0=passthrough, 1=Archivado, 11=Validación, 2=Forzar,
    '               21=Archivar, 100..111=Productos (grupo*4+campo)
    Dim outHdr As Collection, outCol As Collection, outType As Collection, used As Collection
    Set outHdr = New Collection: Set outCol = New Collection
    Set outType = New Collection: Set used = New Collection

    Dim c As Long, hn As String, gi As Long
    For c = 1 To lastCol
        hn = NormHeader(CStr(wsU.Cells(HEADER_ROW, c).Value))
        If hn = "" Then GoTo NextC
        Select Case LCase$(hn)
            Case "estatus"
                AddOut outHdr, outCol, outType, used, "Archivado", c, 1
                AddOut outHdr, outCol, outType, used, "Validación", c, 11
            Case "forzar duplicado"
                AddOut outHdr, outCol, outType, used, "Forzar", c, 2
                AddOut outHdr, outCol, outType, used, "Archivar anterior", c, 21
            Case "productos"
                For gi = 1 To 3
                    AddOut outHdr, outCol, outType, used, "Producto " & gi, c, 100 + (gi - 1) * 4 + 0
                    AddOut outHdr, outCol, outType, used, "Precio " & gi, c, 100 + (gi - 1) * 4 + 1
                    AddOut outHdr, outCol, outType, used, "Cantidad " & gi, c, 100 + (gi - 1) * 4 + 2
                    AddOut outHdr, outCol, outType, used, "Unidad " & gi, c, 100 + (gi - 1) * 4 + 3
                Next gi
            Case "etiqueta planta schneider"
                AddOut outHdr, outCol, outType, used, "Planta Schneider", c, 0
            Case Else
                AddOut outHdr, outCol, outType, used, hn, c, 0
        End Select
NextC:
    Next c

    ' --- leer todos los datos de un jalón (rápido + valores calculados) ---
    Dim data As Variant
    data = wsU.Range(wsU.Cells(DATA_START, 1), wsU.Cells(lastRow, lastCol)).Value

    ' --- construir CSV ---
    Dim sb As String, line As String, i As Long, ri As Long
    Dim col As Long, t As Long, sv As String, vv As Variant, fz As String
    sb = BuildLine(outHdr) & vbCrLf

    For ri = 1 To UBound(data, 1)
        If Trim(CStr(data(ri, pnCol))) = "" Then GoTo NextR   ' saltar filas sin PN
        line = ""
        For i = 1 To outHdr.Count
            t = outType(i): col = outCol(i)
            Select Case t
                Case 0      ' passthrough
                    sv = CellToStr(data(ri, col))
                Case 1      ' Archivado (de Estatus)
                    sv = IIf(InStr(1, CStr(data(ri, col)), "Archivado", vbTextCompare) > 0, "V", "F")
                Case 11     ' Validación (de Estatus)
                    sv = IIf(InStr(1, CStr(data(ri, col)), "sin validación", vbTextCompare) > 0, "F", "V")
                Case 2      ' Forzar (de Forzar duplicado)
                    fz = CStr(data(ri, col))
                    sv = IIf(InStr(1, fz, "Forzar duplicado", vbTextCompare) > 0 _
                             And InStr(1, fz, "Sin forzar", vbTextCompare) = 0, "V", "F")
                Case 21     ' Archivar anterior (de Forzar duplicado)
                    sv = IIf(InStr(1, CStr(data(ri, col)), "archivar anterior", vbTextCompare) > 0, "V", "F")
                Case Is >= 100  ' Productos expandido
                    sv = ProdValue(prodMap, NormKey(CStr(data(ri, col))), t - 100)
            End Select
            If i > 1 Then line = line & ","
            line = line & CsvQuote(sv)
        Next i
        sb = sb & line & vbCrLf
NextR:
    Next ri

    ' --- guardar ---
    Dim fname As String, path As String
    fname = "Plantilla_CargaMasiva_v12_" & Format(Now, "yyyymmdd_hhnnss") & ".csv"
    path = Application.GetSaveAsFilename(InitialFileName:=fname, _
                                        FileFilter:="CSV UTF-8 (*.csv),*.csv")
    If VarType(path) = vbBoolean Then Exit Sub   ' cancelado
    WriteUtf8NoBom CStr(path), sb
    MsgBox "CSV v12 exportado:" & vbCrLf & path & vbCrLf & _
           outHdr.Count & " columnas · " & (UBound(data, 1)) & " filas leídas.", vbInformation
End Sub

' ---------------------------------------------------------------------------
'  Helpers
' ---------------------------------------------------------------------------
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

Private Function ColByHeader(ws As Worksheet, ByVal name As String, ByVal lastCol As Long) As Long
    Dim c As Long
    For c = 1 To lastCol
        If StrComp(NormHeader(CStr(ws.Cells(HEADER_ROW, c).Value)), name, vbTextCompare) = 0 Then
            ColByHeader = c: Exit Function
        End If
    Next c
    ColByHeader = 0
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
                For j = 0 To 11                      ' cols B..M = Producto1..Unidad3
                    s = s & CellToStr(ws.Cells(r, 2 + j).Value) & Chr(1)
                Next j
                On Error Resume Next                 ' ignora keys duplicadas
                col.Add s, key
                On Error GoTo 0
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
            CellToStr = Trim$(Str$(v))          ' punto decimal invariante
        Case vbBoolean
            CellToStr = IIf(v, "V", "F")
        Case vbDate
            CellToStr = Format$(v, "yyyy-mm-dd")
        Case Else
            CellToStr = CStr(v)
    End Select
End Function

Private Function CsvQuote(ByVal s As String) As String
    If InStr(s, ",") > 0 Or InStr(s, """") > 0 Or InStr(s, vbLf) > 0 Or InStr(s, vbCr) > 0 Then
        CsvQuote = """" & Replace(s, """", """""") & """"
    Else
        CsvQuote = s
    End If
End Function

Private Function BuildLine(h As Collection) As String
    Dim i As Long, s As String
    For i = 1 To h.Count
        If i > 1 Then s = s & ","
        s = s & CsvQuote(CStr(h(i)))
    Next i
    BuildLine = s
End Function

Private Function CollHas(c As Collection, ByVal key As String) As Boolean
    Dim v As Variant
    On Error GoTo no
    v = c(key)
    CollHas = True: Exit Function
no:
    CollHas = False
End Function

Private Sub WriteUtf8NoBom(ByVal path As String, ByVal content As String)
    Dim st As Object, bin As Object
    Set st = CreateObject("ADODB.Stream")
    st.Type = 2: st.Charset = "utf-8": st.Open
    st.WriteText content
    ' re-leer como binario saltando los 3 bytes del BOM utf-8
    st.Position = 0: st.Type = 1: st.Position = 3
    Set bin = CreateObject("ADODB.Stream")
    bin.Type = 1: bin.Open
    st.CopyTo bin
    st.Close
    bin.SaveToFile path, 2        ' 2 = sobrescribe
    bin.Close
End Sub
