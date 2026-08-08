Attribute VB_Name = "ModDiagnostico"
' === MODULO DE DIAGNOSTICO (2026-08-08) ===
' Modulo SUELTO: se importa, se corre y se puede borrar. No lo llama nadie y no cambia el
' comportamiento de la plantilla.
'
' Existe porque el sombreado "no reacciona" y llevamos tres intentos de arreglarlo por
' hipotesis. Las causas posibles producen el MISMO sintoma visible y solo se distinguen
' midiendo:
'
'   A. Los eventos de Excel estan apagados  -> Worksheet_Change ni siquiera corre.
'   B. El handler Worksheet_Change no esta en la hoja Upload, o no llama a la macro.
'   C. UserInterfaceOnly no esta activo     -> la macro corre y truena al pintar.
'   D. La macro corre y pinta, pero tarda   -> es un problema de rendimiento.
'   E. La macro corre, pinta y es rapida    -> es un problema de REDIBUJO de pantalla.
'
' SA_PorQueNoSombrea las separa. La prueba clave es la (7): escribe H1 desde VBA y mira si el
' color cambia SOLO. Si no cambia, el evento no esta corriendo y no tiene caso seguir tocando
' la macro -- el problema esta en el handler o en los eventos.

Option Explicit

Public Sub SA_PorQueNoSombrea()
    Dim ws As Worksheet, s As String, t0 As Single
    Dim h1Original As String, colorAntes As Long, colorDespues As Long
    Dim puedePintar As Boolean, eventoCorrio As Boolean, ms As Single

    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets("Upload")
    On Error GoTo 0
    If ws Is Nothing Then
        MsgBox "No encontr" & ChrW(233) & " la hoja 'Upload'.", vbCritical: Exit Sub
    End If

    ' -- 1-3) Estado global de Excel --
    s = "1) EnableEvents .... " & Application.EnableEvents
    If Not Application.EnableEvents Then s = s & "   <<< EVENTOS MUERTOS"
    s = s & vbCrLf
    s = s & "2) ScreenUpdating .. " & Application.ScreenUpdating
    If Not Application.ScreenUpdating Then s = s & "   <<< PANTALLA CONGELADA"
    s = s & vbCrLf
    s = s & "3) Calculation ..... " & Application.Calculation & " (-4105 autom" & ChrW(225) & "tico / -4135 manual)" & vbCrLf & vbCrLf

    ' -- 4-5) Estado de la hoja y de H1 --
    h1Original = CStr(ws.Range("H1").Value)
    s = s & "4) H1 = '" & h1Original & "'   Locked=" & ws.Range("H1").Locked
    If ws.Range("H1").Locked And ws.ProtectContents Then s = s & "   <<< NO SE PUEDE TECLEAR"
    s = s & vbCrLf
    s = s & "5) Upload protegida = " & ws.ProtectContents & vbCrLf & vbCrLf

    ' -- 6) El VBA puede pintar sin desproteger? (prueba real de UserInterfaceOnly) --
    On Error Resume Next
    Err.Clear
    ws.Range("A3").Interior.Color = ws.Range("A3").Interior.Color
    puedePintar = (Err.Number = 0)
    On Error GoTo 0
    s = s & "6) VBA puede pintar sin desproteger = " & puedePintar
    If Not puedePintar Then s = s & "   <<< UserInterfaceOnly NO activo"
    s = s & vbCrLf & vbCrLf

    ' -- 7) LA PRUEBA QUE IMPORTA --
    ' Se escribe H1 desde VBA con los eventos ENCENDIDOS. Si el handler existe y los eventos
    ' viven, Worksheet_Change dispara SombrearModoSoloPN y el color de A3 cambia SOLO.
    ' Si no cambia, el problema NO esta en la macro de sombreado.
    Application.EnableEvents = True
    colorAntes = ws.Range("A3").Interior.Color
    On Error Resume Next
    If InStr(UCase(h1Original), "SOLO") > 0 Then
        ws.Range("H1").Value = "COTIZACI" & ChrW(211) & "N+NP"
    Else
        ws.Range("H1").Value = "SOLO_PN"
    End If
    On Error GoTo 0
    colorDespues = ws.Range("A3").Interior.Color
    eventoCorrio = (colorAntes <> colorDespues)

    ' Dejar H1 como estaba (sin disparar el evento otra vez).
    Application.EnableEvents = False
    On Error Resume Next
    ws.Range("H1").Value = h1Original
    On Error GoTo 0
    Application.EnableEvents = True

    s = s & "7) Al cambiar H1 desde VBA, " & ChrW(191) & "cambi" & ChrW(243) & " el color solo? " & eventoCorrio & vbCrLf
    If eventoCorrio Then
        s = s & "   El evento S" & ChrW(205) & " corre y la macro S" & ChrW(205) & " pinta." & vbCrLf
    Else
        s = s & "   <<< EL EVENTO NO CORRE. El problema no est" & ChrW(225) & " en Module4." & vbCrLf
        s = s & "   Revisa que la hoja Upload (Hoja1) tenga su Worksheet_Change." & vbCrLf
    End If
    s = s & vbCrLf

    ' -- 8) Cuanto tarda la macro llamada a mano? --
    t0 = Timer
    On Error Resume Next
    SombrearModoSoloPN
    On Error GoTo 0
    ms = (Timer - t0) * 1000
    s = s & "8) SombrearModoSoloPN a mano: " & Format(ms, "0") & " ms"
    If ms > 800 Then s = s & "   <<< LENTO"
    s = s & vbCrLf & vbCrLf

    ' -- 9) El color quedo acorde al modo? --
    Dim esperadoGris As Boolean, estaGris As Boolean
    esperadoGris = (InStr(UCase(CStr(ws.Range("H1").Value)), "SOLO") > 0)
    estaGris = (ws.Range("A3").Interior.Color = RGB(125, 125, 125))
    s = s & "9) Modo dice " & IIf(esperadoGris, "SOLO_PN", "COTIZACI" & ChrW(211) & "N+NP") & _
            " y A3 est" & ChrW(225) & " " & IIf(estaGris, "GRIS", "VERDE") & " -> " & _
            IIf(esperadoGris = estaGris, "COHERENTE", "DESINCRONIZADO")

    MsgBox s, vbInformation, "Por qu" & ChrW(233) & " no sombrea"
End Sub

' Boton de panico. Devuelve Excel a un estado sano y vuelve a sincronizar el sombreado.
' Sirve sobre todo cuando los eventos quedaron apagados: eso mata Worksheet_Change para TODA
' la sesion y no hay nada en la pantalla que lo delate -- las cosas simplemente "ya no hacen".
Public Sub SA_Reparar()
    On Error Resume Next
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    Application.Calculation = xlCalculationAutomatic
    Application.CutCopyMode = False
    SA_RehabilitarEscrituraVBA
    SombrearModoSoloPN
    On Error GoTo 0
    MsgBox "Listo:" & vbCrLf & _
           "- Eventos encendidos" & vbCrLf & _
           "- Pantalla y c" & ChrW(225) & "lculo restaurados" & vbCrLf & _
           "- Escritura de macros rehabilitada" & vbCrLf & _
           "- Sombreado resincronizado", vbInformation, "Reparado"
End Sub

' -- PRUEBA DE LOS FEEDERS DE DROPDOWN -----------------------------------------------
' Los dropdowns dependientes (Proceso, Spec 1-4) se filtran a partir de la FILA ACTIVA, que
' la hoja Upload escribe en CAT_Procesos!I2 y CAT_Specs!D2 desde Worksheet_SelectionChange.
' Si ese indicador no se actualiza, las tres causas posibles dan el mismo sintoma:
'
'   A. El handler no esta en la hoja (o se pego en el libro equivocado).
'   B. Los eventos de Excel estan apagados.
'   C. La escritura falla porque la hoja destino esta protegida sin UserInterfaceOnly.
'
' La prueba (4) las separa: selecciona U9 DESDE VBA y mira si I2 toma el valor 9 solo. Si el
' indicador no se mueve pero (3) dice que VBA si puede escribir, el problema es el handler.
Public Sub SA_ProbarFeeders()
    Dim wsUp As Worksheet, wsP As Worksheet, wsS As Worksheet
    Dim s As String, antes As String, seleccionOriginal As String
    Dim i2Antes As String, i2Despues As String, d2Antes As String, d2Despues As String
    Dim puedeI2 As Boolean, puedeD2 As Boolean

    On Error Resume Next
    Set wsUp = ThisWorkbook.Worksheets("Upload")
    Set wsP = ThisWorkbook.Worksheets("CAT_Procesos")
    Set wsS = ThisWorkbook.Worksheets("CAT_Specs")
    On Error GoTo 0
    If wsUp Is Nothing Or wsP Is Nothing Or wsS Is Nothing Then
        MsgBox "Falta alguna de las hojas Upload / CAT_Procesos / CAT_Specs.", vbCritical: Exit Sub
    End If

    s = "1) EnableEvents = " & Application.EnableEvents
    If Not Application.EnableEvents Then s = s & "   <<< EVENTOS MUERTOS"
    s = s & vbCrLf & vbCrLf

    s = s & "2) CAT_Procesos protegida=" & wsP.ProtectContents & "  I2 Locked=" & wsP.Range("I2").Locked & _
            "  valor=" & CStr(wsP.Range("I2").Value) & vbCrLf
    s = s & "   CAT_Specs    protegida=" & wsS.ProtectContents & "  D2 Locked=" & wsS.Range("D2").Locked & _
            "  valor=" & CStr(wsS.Range("D2").Value) & vbCrLf & vbCrLf

    ' 3) Escritura directa desde VBA (prueba de UserInterfaceOnly)
    On Error Resume Next
    Err.Clear
    wsP.Range("I2").Value = wsP.Range("I2").Value
    puedeI2 = (Err.Number = 0)
    Err.Clear
    wsS.Range("D2").Value = wsS.Range("D2").Value
    puedeD2 = (Err.Number = 0)
    On Error GoTo 0
    s = s & "3) VBA puede escribir I2=" & puedeI2 & "  D2=" & puedeD2
    If Not (puedeI2 And puedeD2) Then s = s & "   <<< UserInterfaceOnly NO activo"
    s = s & vbCrLf & vbCrLf

    ' 4) LA PRUEBA QUE IMPORTA: seleccionar desde VBA y ver si el handler reacciona.
    On Error Resume Next
    seleccionOriginal = Selection.Address(External:=False)
    wsUp.Activate
    Application.EnableEvents = True

    i2Antes = CStr(wsP.Range("I2").Value)
    wsUp.Range("U9").Select
    i2Despues = CStr(wsP.Range("I2").Value)

    d2Antes = CStr(wsS.Range("D2").Value)
    wsUp.Range("W10").Select
    d2Despues = CStr(wsS.Range("D2").Value)

    If Len(seleccionOriginal) > 0 Then wsUp.Range(seleccionOriginal).Select
    On Error GoTo 0

    s = s & "4) Al seleccionar U9 desde VBA:  I2 paso de '" & i2Antes & "' a '" & i2Despues & "'"
    If i2Despues = "9" Then s = s & "   OK" Else s = s & "   <<< NO REACCIONO"
    s = s & vbCrLf
    s = s & "   Al seleccionar W10 desde VBA: D2 paso de '" & d2Antes & "' a '" & d2Despues & "'"
    If d2Despues = "10" Then s = s & "   OK" Else s = s & "   <<< NO REACCIONO"
    s = s & vbCrLf & vbCrLf

    If i2Despues = "9" And d2Despues = "10" Then
        s = s & "VEREDICTO: los feeders SI funcionan. Si el indicador no se mueve al hacer" & vbCrLf & _
                "clic A MANO, es el mismo diferimiento de eventos de Excel para Mac que ya" & vbCrLf & _
                "vimos con el dropdown de H1."
    ElseIf puedeI2 And puedeD2 Then
        s = s & "VEREDICTO: VBA SI puede escribir, pero el handler NO reacciona." & vbCrLf & _
                "Revisa que Hoja1 (Upload) tenga su Worksheet_SelectionChange y que sea" & vbCrLf & _
                "la hoja de ESTE libro."
    Else
        s = s & "VEREDICTO: la escritura esta bloqueada. Corre SA_Reparar y repite."
    End If

    MsgBox s, vbInformation, "Prueba de feeders"
End Sub
