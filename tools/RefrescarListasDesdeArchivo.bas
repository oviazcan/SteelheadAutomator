Attribute VB_Name = "Module2"
' === MACRO 2: RefrescarListas (v9) ===
' Lee catálogos desde archivo externo "Catalogos_Steelhead_*.xlsx"
' generado por la extensión Chrome "Actualizar Catálogos"

Sub RefrescarListas()
    Dim catFile As String
    catFile = BuscarArchivoCatalogos()
    If catFile = "" Then Exit Sub

    Application.ScreenUpdating = False
    Application.Calculation = xlCalculationManual

    ' Abrir archivo de catálogos
    Dim wbCat As Workbook
    On Error GoTo ErrorHandler
    Set wbCat = Workbooks.Open(catFile, ReadOnly:=True)
    On Error GoTo 0

    Dim wsL As Worksheet
    Set wsL = ThisWorkbook.Sheets("Listas")

    ' Limpiar datos existentes (cols A-I, preservar J-K, limpiar L-O)
    wsL.Range("A2:I" & Application.Max(wsL.UsedRange.Rows.Count, 2)).ClearContents
    wsL.Range("L2:O" & Application.Max(wsL.UsedRange.Rows.Count, 2)).ClearContents

    ' Cargar cada catálogo desde el archivo externo
    CargarClientesDesde wbCat, wsL
    CargarProcesosDesde wbCat, wsL
    CargarProductosDesde wbCat, wsL
    CargarEtiquetasDesde wbCat, wsL
    CargarSpecsDesde wbCat, wsL
    CargarRacksDesde wbCat, wsL
    CargarLineasDesde wbCat, wsL
    CargarDepartamentosDesde wbCat, wsL
    CargarUsuariosDesde wbCat, wsL
    CargarGruposDesde wbCat, wsL

    ' Cerrar archivo de catálogos sin guardar
    wbCat.Close SaveChanges:=False

    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True

    MsgBox "Listas actualizadas desde catálogos:" & vbCrLf & vbCrLf & _
        NContar(wsL, 1) & " clientes" & vbCrLf & _
        NContar(wsL, 2) & " procesos" & vbCrLf & _
        NContar(wsL, 3) & " productos" & vbCrLf & _
        NContar(wsL, 4) & " etiquetas" & vbCrLf & _
        NContar(wsL, 5) & " specs" & vbCrLf & _
        NContar(wsL, 6) & " racks línea" & vbCrLf & _
        NContar(wsL, 7) & " racks todos" & vbCrLf & _
        NContar(wsL, 12) & " líneas" & vbCrLf & _
        NContar(wsL, 13) & " departamentos" & vbCrLf & _
        NContar(wsL, 14) & " usuarios" & vbCrLf & _
        NContar(wsL, 15) & " grupos PN", vbInformation, "RefrescarListas"
    Exit Sub

ErrorHandler:
    Application.Calculation = xlCalculationAutomatic
    Application.ScreenUpdating = True
    MsgBox "Error abriendo archivo de catálogos: " & Err.Description, vbCritical
End Sub

' === BUSCAR ARCHIVO DE CATÁLOGOS ===
' Busca el archivo más reciente "Catalogos_Steelhead_*.xlsx" en:
' 1. Misma carpeta que la plantilla
' 2. Carpeta Downloads del usuario
' Si encuentra, pregunta al usuario si lo acepta. Si no, deja buscar manual.
Private Function BuscarArchivoCatalogos() As String
    Dim found As String
    found = ""

    ' Buscar en misma carpeta que la plantilla
    Dim plantillaDir As String
    plantillaDir = ThisWorkbook.Path
    If plantillaDir <> "" Then
        found = BuscarMasReciente(plantillaDir)
    End If

    ' Si no encontró, buscar en Downloads
    If found = "" Then
        Dim downloadsDir As String
        #If Mac Then
            downloadsDir = Environ("HOME") & "/Downloads"
        #Else
            downloadsDir = Environ("USERPROFILE") & "\Downloads"
        #End If
        found = BuscarMasReciente(downloadsDir)
    End If

    If found <> "" Then
        ' Mostrar al usuario el archivo encontrado
        Dim resp As VbMsgBoxResult
        resp = MsgBox("Archivo de catálogos encontrado:" & vbCrLf & vbCrLf & _
            Dir(found) & vbCrLf & _
            "(" & found & ")" & vbCrLf & vbCrLf & _
            "¿Usar este archivo?" & vbCrLf & vbCrLf & _
            "Sí = Usar este archivo" & vbCrLf & _
            "No = Buscar otro manualmente" & vbCrLf & _
            "Cancelar = No actualizar", _
            vbYesNoCancel + vbQuestion, "RefrescarListas")

        If resp = vbYes Then
            BuscarArchivoCatalogos = found
            Exit Function
        ElseIf resp = vbCancel Then
            BuscarArchivoCatalogos = ""
            Exit Function
        End If
        ' resp = vbNo → cae al selector manual
    End If

    ' Selector manual
    Dim result As Variant
    #If Mac Then
        ' Mac: GetOpenFilename sin FileFilter
        result = Application.GetOpenFilename( _
            Title:="Selecciona el archivo de Catálogos Steelhead")
    #Else
        result = Application.GetOpenFilename( _
            FileFilter:="Archivos Excel (*.xlsx),*.xlsx,Todos (*.*),*.*", _
            Title:="Selecciona el archivo de Catálogos Steelhead")
    #End If
    If VarType(result) = vbBoolean Then
        BuscarArchivoCatalogos = ""
    Else
        BuscarArchivoCatalogos = CStr(result)
    End If
End Function

' Busca el archivo "Catalogos_Steelhead_*.xlsx" más reciente en una carpeta
Private Function BuscarMasReciente(folderPath As String) As String
    Dim fileName As String
    Dim bestFile As String
    Dim bestDate As Date

    bestFile = ""
    bestDate = 0

    On Error Resume Next
    fileName = Dir(folderPath & Application.PathSeparator & "Catalogos_Steelhead_*.xlsx")
    On Error GoTo 0

    Do While fileName <> ""
        Dim fullPath As String
        fullPath = folderPath & Application.PathSeparator & fileName
        Dim fDate As Date
        fDate = FileDateTime(fullPath)
        If fDate > bestDate Then
            bestDate = fDate
            bestFile = fullPath
        End If
        fileName = Dir()
    Loop

    BuscarMasReciente = bestFile
End Function

' === CLIENTES: "Nombre — Dirección", ID, Etiquetas ===
Private Sub CargarClientesDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long
    Dim nombre As String, addr As String, combo As String
    Dim combos As New Collection
    Dim ids As New Collection
    Dim etqs As New Collection

    Set ws = wbCat.Sheets("Clientes")
    For r = 2 To ws.Cells(ws.Rows.Count, 2).End(xlUp).Row
        If ws.Cells(r, 6).Value = True Then
            nombre = CStr(ws.Cells(r, 2).Value)
            addr = Replace(Replace(CStr(ws.Cells(r, 10).Value), vbLf, " "), vbCr, " ")
            If Len(addr) > 40 Then addr = Left(addr, 40)
            combo = nombre & " " & ChrW(8212) & " " & addr
            On Error Resume Next
            combos.Add combo, combo
            If Err.Number = 0 Then
                ids.Add CStr(ws.Cells(r, 1).Value), combo
                etqs.Add CStr(ws.Cells(r, 12).Value), combo
            End If
            Err.Clear
            On Error GoTo 0
        End If
    Next r

    Dim arr() As String, arrId() As String, arrEtq() As String
    Dim n As Long
    n = combos.Count
    If n = 0 Then Exit Sub
    ReDim arr(1 To n): ReDim arrId(1 To n): ReDim arrEtq(1 To n)
    Dim i As Long
    For i = 1 To n
        arr(i) = combos(i): arrId(i) = ids(combos(i)): arrEtq(i) = etqs(combos(i))
    Next i
    ' Sort
    Dim j As Long, tmp As String
    For i = 1 To n - 1
        For j = i + 1 To n
            If StrComp(arr(i), arr(j), vbTextCompare) > 0 Then
                tmp = arr(i): arr(i) = arr(j): arr(j) = tmp
                tmp = arrId(i): arrId(i) = arrId(j): arrId(j) = tmp
                tmp = arrEtq(i): arrEtq(i) = arrEtq(j): arrEtq(j) = tmp
            End If
        Next j
    Next i
    For i = 1 To n
        wsL.Cells(i + 1, 1).Value = arr(i)
        wsL.Cells(i + 1, 8).Value = arrId(i)
        wsL.Cells(i + 1, 9).Value = arrEtq(i)
    Next i
End Sub

' === PROCESOS ===
Private Sub CargarProcesosDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim items As New Collection
    Set ws = wbCat.Sheets("Procesos")
    For r = 2 To ws.Cells(ws.Rows.Count, 2).End(xlUp).Row
        If CStr(ws.Cells(r, 3).Value) = "process" And CStr(ws.Cells(r, 5).Value) = "No" Then
            v = CStr(ws.Cells(r, 2).Value)
            If v <> "" Then
                On Error Resume Next: items.Add v, v: On Error GoTo 0
            End If
        End If
    Next r
    EscribirOrdenado wsL, 2, items
End Sub

' === PRODUCTOS ===
Private Sub CargarProductosDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim items As New Collection
    Set ws = wbCat.Sheets("Productos")
    For r = 2 To ws.Cells(ws.Rows.Count, 2).End(xlUp).Row
        If CStr(ws.Cells(r, 4).Value) = "Activo" Then
            v = CStr(ws.Cells(r, 2).Value)
            If v <> "" Then
                On Error Resume Next: items.Add v, v: On Error GoTo 0
            End If
        End If
    Next r
    EscribirOrdenado wsL, 3, items
End Sub

' === ETIQUETAS ===
Private Sub CargarEtiquetasDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim items As New Collection
    Set ws = wbCat.Sheets("Etiquetas")
    For r = 2 To ws.Cells(ws.Rows.Count, 6).End(xlUp).Row
        If IsEmpty(ws.Cells(r, 4).Value) Or CStr(ws.Cells(r, 4).Value) = "" Then
            v = CStr(ws.Cells(r, 6).Value)
            If v <> "" Then
                On Error Resume Next: items.Add v, v: On Error GoTo 0
            End If
        End If
    Next r
    EscribirOrdenado wsL, 4, items
End Sub

' === SPECS: "SpecName | ParamEspesor" ===
Private Sub CargarSpecsDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long
    Dim specName As String, fieldName As String, paramName As String
    Dim specSeen As New Collection
    Dim espesorEntries As New Collection
    Dim specsWithEspesor As New Collection
    Set ws = wbCat.Sheets("Especificaciones")
    Dim lastR As Long
    lastR = ws.Cells(ws.Rows.Count, 3).End(xlUp).Row
    For r = 2 To lastR
        specName = Trim(CStr(ws.Cells(r, 3).Value))
        fieldName = CStr(ws.Cells(r, 17).Value)
        paramName = Trim(CStr(ws.Cells(r, 22).Value))
        If specName = "" Then GoTo NextRow
        On Error Resume Next: specSeen.Add specName, specName: On Error GoTo 0
        If InStr(1, fieldName, "espesor", vbTextCompare) > 0 And paramName <> "" Then
            Dim entry As String
            entry = specName & " | " & paramName
            On Error Resume Next
            espesorEntries.Add entry, entry
            If Err.Number = 0 Then specsWithEspesor.Add specName, specName
            Err.Clear
            On Error GoTo 0
        End If
NextRow:
    Next r
    Dim finalItems As New Collection
    Dim i As Long
    For i = 1 To espesorEntries.Count
        On Error Resume Next: finalItems.Add espesorEntries(i), espesorEntries(i): On Error GoTo 0
    Next i
    For i = 1 To specSeen.Count
        Dim sn As String
        sn = specSeen(i)
        Dim hasEsp As Boolean
        hasEsp = False
        On Error Resume Next
        Dim dummy As String
        dummy = specsWithEspesor(sn)
        If Err.Number = 0 Then hasEsp = True
        Err.Clear
        On Error GoTo 0
        If Not hasEsp Then
            On Error Resume Next: finalItems.Add sn, sn: On Error GoTo 0
        End If
    Next i
    EscribirOrdenado wsL, 5, finalItems
End Sub

' === RACKS: Línea (FL/BA/Barril) y Todos ===
Private Sub CargarRacksDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim linea As New Collection, todos As New Collection
    Set ws = wbCat.Sheets("Racks")
    For r = 2 To ws.Cells(ws.Rows.Count, 5).End(xlUp).Row
        v = CStr(ws.Cells(r, 5).Value)
        If v <> "" Then
            On Error Resume Next: todos.Add v, v: On Error GoTo 0
            If InStr(v, "-FL") > 0 Or InStr(v, "-BA") > 0 Or InStr(v, "Barril") > 0 Then
                On Error Resume Next: linea.Add v, v: On Error GoTo 0
            End If
        End If
    Next r
    EscribirOrdenado wsL, 6, linea
    EscribirOrdenado wsL, 7, todos
End Sub

' === LÍNEAS (col L en Listas) ===
Private Sub CargarLineasDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim items As New Collection
    On Error Resume Next
    Set ws = wbCat.Sheets("Líneas")
    On Error GoTo 0
    If ws Is Nothing Then Exit Sub
    For r = 2 To ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
        v = Trim(CStr(ws.Cells(r, 1).Value))
        If v <> "" Then
            On Error Resume Next: items.Add v, v: On Error GoTo 0
        End If
    Next r
    EscribirOrdenado wsL, 12, items
End Sub

' === DEPARTAMENTOS (col M en Listas) ===
Private Sub CargarDepartamentosDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim items As New Collection
    On Error Resume Next
    Set ws = wbCat.Sheets("Departamentos")
    On Error GoTo 0
    If ws Is Nothing Then Exit Sub
    For r = 2 To ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
        v = Trim(CStr(ws.Cells(r, 1).Value))
        If v <> "" Then
            On Error Resume Next: items.Add v, v: On Error GoTo 0
        End If
    Next r
    EscribirOrdenado wsL, 13, items
End Sub

' === USUARIOS (col N en Listas) ===
Private Sub CargarUsuariosDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim items As New Collection
    On Error Resume Next
    Set ws = wbCat.Sheets("Usuarios")
    On Error GoTo 0
    If ws Is Nothing Then Exit Sub
    For r = 2 To ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
        v = Trim(CStr(ws.Cells(r, 1).Value))
        If v <> "" Then
            On Error Resume Next: items.Add v, v: On Error GoTo 0
        End If
    Next r
    EscribirOrdenado wsL, 14, items
End Sub

' === GRUPOS PN (col O en Listas) ===
Private Sub CargarGruposDesde(wbCat As Workbook, wsL As Worksheet)
    Dim ws As Worksheet, r As Long, v As String
    Dim items As New Collection
    On Error Resume Next
    Set ws = wbCat.Sheets("Grupos")
    On Error GoTo 0
    If ws Is Nothing Then Exit Sub
    For r = 2 To ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
        v = Trim(CStr(ws.Cells(r, 1).Value))
        If v <> "" Then
            On Error Resume Next: items.Add v, v: On Error GoTo 0
        End If
    Next r
    EscribirOrdenado wsL, 15, items
End Sub

' === HELPERS ===
Private Sub EscribirOrdenado(ws As Worksheet, col As Long, items As Collection)
    If items.Count = 0 Then Exit Sub
    Dim arr() As String, i As Long, j As Long, tmp As String
    ReDim arr(1 To items.Count)
    For i = 1 To items.Count: arr(i) = items(i): Next i
    For i = 1 To UBound(arr) - 1
        For j = i + 1 To UBound(arr)
            If StrComp(arr(i), arr(j), vbTextCompare) > 0 Then
                tmp = arr(i): arr(i) = arr(j): arr(j) = tmp
            End If
        Next j
    Next i
    For i = 1 To UBound(arr): ws.Cells(i + 1, col).Value = arr(i): Next i
End Sub

Private Function NContar(ws As Worksheet, col As Long) As Long
    Dim r As Long, n As Long
    For r = 2 To Application.Max(ws.UsedRange.Rows.Count, 2)
        If CStr(ws.Cells(r, col).Value) <> "" Then n = n + 1
    Next r
    NContar = n
End Function
