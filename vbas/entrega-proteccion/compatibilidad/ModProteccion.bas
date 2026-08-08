Attribute VB_Name = "ModProteccion"
' === MODULO DE PROTECCION (v1 -- 2026-08-07) ===
' Las plantillas se entregan PROTEGIDAS para que el operador solo pueda escribir en los
' campos de captura. Toda macro que ESCRIBE truena con error 1004 sobre una hoja protegida,
' asi que aqui vive el par desproteger/reproteger que usan TODAS.
'
' -- QUE HACE Y QUE *NO* HACE --------------------------------------------------------
' NO decide que celda va bloqueada o desbloqueada: eso se aplica a mano sobre la plantilla
' y viaja guardado dentro del archivo. Este modulo solo levanta y vuelve a poner el candado
' de las HOJAS (y de la estructura del LIBRO).
'
' -- LA REGLA: SE RESTAURA LO QUE HABIA, NO LO QUE YO SUPONGA ------------------------
' SA_Desproteger toma una FOTO del estado de proteccion (que hojas estaban protegidas y con
' que banderas exactas) antes de quitarlo, y SA_Proteger repone ESA foto. Nunca protege con
' banderas fijas escritas aqui.
' Por que importa: la plantilla v13 del 2026-08-07 esta protegida con
' `sheet="1" objects="1" scenarios="1"` y NINGUN Allow*, y solo 5 de sus 8 hojas estan
' protegidas (Listas, Ayuda y CAT_Procesos NO lo estan). Si al terminar una macro yo
' protegiera "todas las hojas" con mis propias banderas, cada corrida de LimpiarDatos
' cambiaria en silencio la configuracion del archivo -- y protegeria de mas tres hojas que
' el diseno dejo abiertas a proposito. Con la foto, correr una macro deja el archivo
' exactamente como estaba.
' Corolario: si manana se protege una hoja mas, o se habilita "permitir filtrar",
' este modulo lo respeta solo. No hay lista de hojas que mantener.
'
' -- FAIL-SAFE -----------------------------------------------------------------------
' Si no hay foto (nadie llamo SA_Desproteger), SA_Proteger NO HACE NADA. Jamas inventa un
' candado donde no lo habia: un falso "protegido" deja al operador sin poder capturar y sin
' explicacion de por que.
'
' -- SIN CONTRASENA, A PROPOSITO -----------------------------------------------------
' El objetivo es evitar errores de captura, no proteger informacion: quien sepa lo que hace
' puede quitar el candado desde la cinta de Excel. Si algun dia se le pone contrasena, hay
' que cambiar SA_PWD aqui (un solo lugar) -- y saber que a partir de ahi un fallo a media
' macro deja el archivo protegido sin que nadie pueda abrirlo a mano.
'
' -- COMO SE USA EN CADA MACRO -------------------------------------------------------
'   On Error GoTo Cleanup
'   SA_Desproteger
'   ... trabajo ...
' Cleanup:
'   SA_Proteger        ' <- SIEMPRE, aunque haya reventado a media ejecucion
'
' El `Cleanup` no es adorno: sin el, una macro que truena a la mitad deja el archivo SIN
' proteccion y nadie se entera hasta que alguien borra una formula.
'
' -- UserInterfaceOnly ---------------------------------------------------------------
' Al reponer el candado se agrega UserInterfaceOnly:=True: el VBA puede escribir aunque la
' hoja este protegida, el usuario no. Es lo que evita que Worksheet_SelectionChange truene
' en CADA clic sobre las columnas Proceso y Spec 1-4 (escribe la fila activa en
' CAT_Procesos!I2 y CAT_Specs!D2 para alimentar los dropdowns dependientes).
' OJO: esa bandera NO se guarda con el archivo. Al reabrir, la hoja vuelve a estar protegida
' tambien para las macros; por eso ThisWorkbook.Workbook_Open la repone. El
' desproteger/reproteger explicito de cada macro es el cinturon que las hace funcionar aunque
' Workbook_Open no haya corrido (p. ej. si se abrio con macros deshabilitadas y se activaron
' despues).

Option Explicit

' Sin contrasena, a proposito (ver encabezado).
Public Const SA_PWD As String = ""

Private Type SA_EstadoHoja
    nombre As String
    protegida As Boolean      ' protegida de ALGUNA forma (contenido, objetos o escenarios)
    contenido As Boolean
    objetos As Boolean
    escenarios As Boolean
    seleccion As Long
    fmtCeldas As Boolean
    fmtColumnas As Boolean
    fmtFilas As Boolean
    insColumnas As Boolean
    insFilas As Boolean
    insHipervinculos As Boolean
    delColumnas As Boolean
    delFilas As Boolean
    ordenar As Boolean
    filtrar As Boolean
    dinamicas As Boolean
End Type

Private mHojas() As SA_EstadoHoja
Private mNumHojas As Long
Private mLibroEstructura As Boolean
Private mLibroVentanas As Boolean
Private mHayFoto As Boolean
' Contador de anidamiento: SombrearModoSoloPN se dispara desde Worksheet_Change y puede
' correr DENTRO de otra macro que ya desprotegio. Sin este contador, la de adentro tomaria
' una foto de "todo desprotegido" y al salir borraria el candado para siempre.
Private mNivel As Long
' Estado guardado de SA_Diagnostico (ver sec.Diagnostico, mas abajo). Vive aqui, y no junto a
' su Sub, porque VBA exige que TODAS las declaraciones de modulo esten antes del primer
' procedimiento: una sola linea `Private ... As String` a media altura tumba la compilacion
' del modulo entero con "Only comments may appear after End Sub".
Private mHuellaPrevia As String

' Donde estaba parado el operador antes de la macro (ver sec.Volver a donde estabas).
Private mHojaActiva As String
Private mSeleccion As String
Private mPrevActualiza As Boolean

' ==========================  API que usan las macros  ==========================

' Desprotege SOLO las hojas que se le nombren. Sin argumentos, todas (compatibilidad).
'
' Nombrar las hojas NO es microoptimizacion, es la diferencia entre reaccionar y no
' reaccionar. Medido sobre la plantilla v13: las 8 hojas suman 59,765 celdas y 17,897
' formulas, y el ciclo hace Unprotect + Protect sobre cada una = 16 operaciones. Con
' SombrearModoSoloPN colgado de Worksheet_Change, eso corria ENTERO en cada cambio de H1
' -- para pintar tres rangos de una sola hoja. El sintoma reportado desde piso fue "ya no
' reacciona de inmediato como antes; hay que guardar, cerrar o cambiar de pestana, y a
' veces jala y a veces no".
' Con "Upload" son 2 operaciones sobre 1 hoja.
'
' Regla: cada macro pide EXACTAMENTE las hojas donde escribe. Es mas rapido, y ademas
' reduce la superficie de efectos secundarios -- cada Protect sobre una hoja es una
' oportunidad de que Excel la active o mueva el foco.
Public Sub SA_Desproteger(ParamArray nombres() As Variant)
    Dim ws As Worksheet, i As Long, k As Long

    mNivel = mNivel + 1

    ' La FOTO se toma la primera vez, y la condicion es "ya tengo foto?", no "en que nivel
    ' voy?". Son cosas distintas y confundirlas es fragil: mNivel decide cuando REPONER, y
    ' mHayFoto decide si hay algo que reponer.
    If Not mHayFoto Then
        ' Donde estaba parado el operador, para devolverlo ahi (ver sec.Volver a donde estabas).
        ' Y se apaga el refresco de pantalla: recorrer 8 hojas quitando y poniendo el candado
        ' parpadea aunque no cambie nada.
        mPrevActualiza = Application.ScreenUpdating
        Application.ScreenUpdating = False
        mHojaActiva = "": mSeleccion = ""
        On Error Resume Next
        mHojaActiva = ThisWorkbook.ActiveSheet.Name
        If TypeName(Selection) = "Range" Then mSeleccion = Selection.Address(External:=False)
        On Error GoTo 0

        On Error Resume Next
        mLibroEstructura = ThisWorkbook.ProtectStructure
        mLibroVentanas = ThisWorkbook.ProtectWindows
        On Error GoTo 0

        If UBound(nombres) < 0 Then                 ' sin argumentos: todas
            mNumHojas = ThisWorkbook.Worksheets.Count
            ReDim mHojas(1 To mNumHojas)
            i = 0
            For Each ws In ThisWorkbook.Worksheets
                i = i + 1
                SA_Fotografiar ws, mHojas(i)
            Next ws
        Else                                        ' solo las nombradas
            ReDim mHojas(1 To UBound(nombres) - LBound(nombres) + 1)
            mNumHojas = 0
            For k = LBound(nombres) To UBound(nombres)
                Set ws = Nothing
                On Error Resume Next
                Set ws = ThisWorkbook.Worksheets(CStr(nombres(k)))
                On Error GoTo 0
                ' Una hoja que no existe se ignora en silencio: un nombre mal escrito no
                ' puede tumbar la macro ni, peor, dejar de reproteger las demas.
                If Not ws Is Nothing Then
                    mNumHojas = mNumHojas + 1
                    SA_Fotografiar ws, mHojas(mNumHojas)
                End If
            Next k
        End If

        mHayFoto = True
    End If

    ' Desproteger va SIEMPRE, fuera del If, aunque parezca redundante en una llamada anidada.
    ' Es idempotente (desproteger lo desprotegido no cuesta nada) y compra una garantia que
    ' vale mucho: si mNivel se descuadrara por cualquier camino, la macro SIGUE funcionando.
    ' Con el desproteger dentro del If, un contador descuadrado dejaba la hoja bloqueada y
    ' TODAS las macros muertas a partir de ahi -- un fallo silencioso y permanente. Asi, lo
    ' peor que puede pasar es que una vez no se reproteja: visible y recuperable.
    For i = 1 To mNumHojas
        Set ws = Nothing
        On Error Resume Next
        Set ws = ThisWorkbook.Worksheets(mHojas(i).nombre)
        If Not ws Is Nothing Then ws.Unprotect SA_PWD
        On Error GoTo 0
    Next i

    ' La estructura del libro se quita al final: mientras este puesta, no se pueden
    ' agregar/mover/copiar hojas (RefrescarListas y el volcado del CSV abren otros libros,
    ' pero una futura macro podria necesitarlo).
    If mLibroEstructura Or mLibroVentanas Then
        On Error Resume Next
        ThisWorkbook.Unprotect SA_PWD
        On Error GoTo 0
    End If
End Sub

Public Sub SA_Proteger()
    If mNivel > 0 Then mNivel = mNivel - 1
    If mNivel > 0 Then Exit Sub          ' todavia hay una macro externa trabajando

    ' Sin foto no se inventa un candado (ver sec.FAIL-SAFE).
    If Not mHayFoto Then Exit Sub

    Dim ws As Worksheet, i As Long
    For i = 1 To mNumHojas
        Set ws = Nothing
        On Error Resume Next
        Set ws = ThisWorkbook.Worksheets(mHojas(i).nombre)
        On Error GoTo 0
        If Not ws Is Nothing Then SA_Reponer ws, mHojas(i)
    Next i

    If mLibroEstructura Or mLibroVentanas Then
        On Error Resume Next
        ThisWorkbook.Protect Password:=SA_PWD, _
                             Structure:=mLibroEstructura, Windows:=mLibroVentanas
        On Error GoTo 0
    End If

    SA_VolverDondeEstaba

    ' Red de seguridad contra una sesion envenenada. Worksheet_SelectionChange (hoja Upload)
    ' apaga los eventos para escribir la fila activa en los feeders y los vuelve a encender
    ' en la linea siguiente; si esa escritura falla, el `EnableEvents = True` NUNCA se
    ' ejecuta y los eventos quedan apagados PARA TODA LA SESION -- el sombreado por cambio de
    ' modo deja de dispararse, los dropdowns dependientes dejan de filtrarse, y nada lo
    ' delata salvo que las cosas "ya no hacen nada". Cerrar y reabrir es la unica cura.
    ' Encenderlos aqui es gratis y rompe ese ciclo en la siguiente macro que se ejecute.
    ' (Ninguna macro de este proyecto apaga eventos a proposito y espera que sigan apagados
    '  al pasar por aqui; si alguna lo hiciera, tendria que reactivarlos ella misma.)
    Application.EnableEvents = True
    Application.ScreenUpdating = mPrevActualiza

    ' Forzar el repintado. Volver a poner ScreenUpdating en True NO siempre redibuja la hoja
    ' activa en Excel para Mac: el formato ya esta aplicado pero la pantalla sigue mostrando
    ' lo anterior hasta que algo la obligue -- guardar, cambiar de pestana, minimizar. Ese era
    ' exactamente el reporte de piso ("a veces jala y a veces no"), y lleva a diagnosticar un
    ' problema de logica cuando es de dibujo. Un scroll de cero filas es un no-op logico que
    ' obliga a Excel a redibujar.
    If mPrevActualiza Then
        On Error Resume Next
        ActiveWindow.SmallScroll Down:=0
        On Error GoTo 0
    End If

    mHayFoto = False
End Sub

' -- Volver a donde estabas ----------------------------------------------------------
' Al terminar una macro, Excel se quedaba en una hoja distinta de Upload -- molesto, porque
' Upload es donde viven los botones y donde el operador estaba capturando.
' El culpable es el propio ciclo de proteccion: varias operaciones sobre una hoja
' (senaladamente asignar EnableSelection) hacen que Excel la ACTIVE, y como el ciclo recorre
' las 8, la ultima gana. Se ataca por los dos lados:
'   1. SA_Reponer ya no escribe EnableSelection si el valor no cambio (causa probable).
'   2. Esto: se guarda la hoja y la seleccion al entrar y se restauran al salir.
' El (2) existe porque el (1) es una HIPOTESIS que no se puede verificar sin Excel. Restaurar
' la posicion garantiza el resultado sin importar cual sea la causa real -- y sigue siendo
' correcto si manana una macro nueva cambia de hoja por otro motivo.
'
' Solo restaura si ThisWorkbook es el libro activo: si el operador se fue a otro archivo
' mientras corria la macro, activar una hoja de este le robaria el foco, que es peor que el
' problema que se esta arreglando.
Private Sub SA_VolverDondeEstaba()
    If Len(mHojaActiva) = 0 Then Exit Sub
    On Error Resume Next
    If Not (ActiveWorkbook Is ThisWorkbook) Then Exit Sub
    If ThisWorkbook.ActiveSheet.Name <> mHojaActiva Then
        ThisWorkbook.Worksheets(mHojaActiva).Activate
    End If
    ' La seleccion se repone solo si de verdad se movio: un Select innecesario tambien
    ' desplaza el scroll de la ventana.
    If Len(mSeleccion) > 0 And TypeName(Selection) = "Range" Then
        If Selection.Address(External:=False) <> mSeleccion Then
            ThisWorkbook.Worksheets(mHojaActiva).Range(mSeleccion).Select
        End If
    End If
    On Error GoTo 0
End Sub

' Repone el candado tal como estaba al abrir el archivo, agregando UserInterfaceOnly.
' Se llama desde ThisWorkbook.Workbook_Open porque UserInterfaceOnly no se guarda con el
' archivo: sin esto, el feeder de los dropdowns truena en el primer clic de la sesion.
Public Sub SA_RehabilitarEscrituraVBA()
    Dim ws As Worksheet
    Dim e As SA_EstadoHoja
    Dim prevActualiza As Boolean, hoja As String

    ' Mismo cuidado que en SA_Desproteger: este ciclo tambien puede mover la hoja activa, y
    ' aqui doleria el doble -- el archivo abriria en una hoja distinta de la que se guardo.
    prevActualiza = Application.ScreenUpdating
    Application.ScreenUpdating = False
    hoja = ""
    On Error Resume Next
    hoja = ThisWorkbook.ActiveSheet.Name
    On Error GoTo 0

    For Each ws In ThisWorkbook.Worksheets
        If ws.ProtectContents Or ws.ProtectDrawingObjects Or ws.ProtectScenarios Then
            SA_Fotografiar ws, e
            On Error Resume Next
            ws.Unprotect SA_PWD
            On Error GoTo 0
            SA_Reponer ws, e
        End If
    Next ws

    On Error Resume Next
    If Len(hoja) > 0 Then
        If ThisWorkbook.ActiveSheet.Name <> hoja Then ThisWorkbook.Worksheets(hoja).Activate
    End If
    On Error GoTo 0
    Application.ScreenUpdating = prevActualiza
End Sub

' ==========================  Diagnostico  ==========================

' Comprueba, sobre el archivo REAL, que correr una macro no cambia la configuracion de
' proteccion. No hay que creerle a nadie:
'
'   1. Corre SA_Diagnostico  -> "estado capturado"
'   2. Corre la macro que quieras (LimpiarDatos, RefrescarListas, lo que sea)
'   3. Corre SA_Diagnostico otra vez -> dice IGUAL, o lista exactamente que cambio
'
' Se puede repetir cuantas veces se quiera: cada comparacion deja capturado el estado nuevo.
' (mHuellaPrevia se declara arriba, en la seccion de declaraciones del modulo.)

Public Sub SA_Diagnostico()
    Dim actual As String
    actual = SA_Huella()

    If Len(mHuellaPrevia) = 0 Then
        mHuellaPrevia = actual
        MsgBox "Estado de protecci" & ChrW(243) & "n CAPTURADO:" & vbCrLf & vbCrLf & actual & vbCrLf & _
               "Ahora corre la macro que quieras probar y vuelve a ejecutar SA_Diagnostico.", _
               vbInformation, "Diagn" & ChrW(243) & "stico 1 de 2"
        Exit Sub
    End If

    Dim a() As String, b() As String, i As Long, difs As String, n As Long
    a = Split(mHuellaPrevia, vbCrLf)
    b = Split(actual, vbCrLf)
    For i = 0 To UBound(a)
        If i > UBound(b) Then
            difs = difs & "  FALTA: " & a(i) & vbCrLf: n = n + 1
        ElseIf a(i) <> b(i) Then
            difs = difs & "  ANTES: " & a(i) & vbCrLf & "  AHORA: " & b(i) & vbCrLf: n = n + 1
        End If
    Next i
    If UBound(b) > UBound(a) Then
        For i = UBound(a) + 1 To UBound(b)
            difs = difs & "  NUEVA: " & b(i) & vbCrLf: n = n + 1
        Next i
    End If

    mHuellaPrevia = actual

    If n = 0 Then
        MsgBox "IGUAL. La protecci" & ChrW(243) & "n qued" & ChrW(243) & " exactamente como estaba:" & _
               vbCrLf & vbCrLf & actual, vbInformation, "Sin cambios"
    Else
        MsgBox n & " diferencia(s) en la protecci" & ChrW(243) & "n:" & vbCrLf & vbCrLf & difs & vbCrLf & _
               "Si no las esperabas, av" & ChrW(237) & "sale a quien mantiene las macros.", _
               vbExclamation, "La protecci" & ChrW(243) & "n CAMBI" & ChrW(211)
    End If
End Sub

' Mide cuanto tarda el ciclo de proteccion, hoja por hoja y en total. Sirve para contestar
' con un numero --y no con una teoria-- la pregunta "por que no reacciona de inmediato?".
' El costo NO es parejo: depende de cuantas celdas y formulas tenga cada hoja, y en esta
' plantilla van de 141 celdas (Ayuda) a 33,811 (Upload).
Public Sub SA_MedirTiempos()
    Dim ws As Worksheet, t0 As Single, s As String, total As Single
    For Each ws In ThisWorkbook.Worksheets
        If ws.ProtectContents Or ws.ProtectDrawingObjects Or ws.ProtectScenarios Then
            Dim e As SA_EstadoHoja
            SA_Fotografiar ws, e
            t0 = Timer
            On Error Resume Next
            ws.Unprotect SA_PWD
            On Error GoTo 0
            SA_Reponer ws, e
            s = s & "  " & ws.Name & ": " & Format((Timer - t0) * 1000, "0") & " ms" & vbCrLf
            total = total + (Timer - t0)
        Else
            s = s & "  " & ws.Name & ": (sin proteger)" & vbCrLf
        End If
    Next ws
    MsgBox "Unprotect + Protect por hoja:" & vbCrLf & vbCrLf & s & vbCrLf & _
           "TOTAL de recorrer TODAS: " & Format(total * 1000, "0") & " ms" & vbCrLf & vbCrLf & _
           "Cada macro s" & ChrW(243) & "lo desprotege las hojas donde escribe, as" & ChrW(237) & _
           " que su costo real es el de esas hojas, no el total.", _
           vbInformation, "Tiempos de protecci" & ChrW(243) & "n"
End Sub

' Una linea por hoja con todo lo que este modulo promete conservar.
Private Function SA_Huella() As String
    Dim ws As Worksheet, s As String
    s = "LIBRO: estructura=" & ThisWorkbook.ProtectStructure & _
        " ventanas=" & ThisWorkbook.ProtectWindows & vbCrLf
    For Each ws In ThisWorkbook.Worksheets
        s = s & ws.Name & ": "
        If Not (ws.ProtectContents Or ws.ProtectDrawingObjects Or ws.ProtectScenarios) Then
            s = s & "SIN PROTEGER"
        Else
            s = s & "cont=" & Abs(CInt(ws.ProtectContents)) & _
                    " obj=" & Abs(CInt(ws.ProtectDrawingObjects)) & _
                    " esc=" & Abs(CInt(ws.ProtectScenarios)) & _
                    " sel=" & ws.EnableSelection & " allow="
            On Error Resume Next
            s = s & Abs(CInt(ws.Protection.AllowFormattingCells)) & _
                    Abs(CInt(ws.Protection.AllowFormattingColumns)) & _
                    Abs(CInt(ws.Protection.AllowFormattingRows)) & _
                    Abs(CInt(ws.Protection.AllowInsertingColumns)) & _
                    Abs(CInt(ws.Protection.AllowInsertingRows)) & _
                    Abs(CInt(ws.Protection.AllowInsertingHyperlinks)) & _
                    Abs(CInt(ws.Protection.AllowDeletingColumns)) & _
                    Abs(CInt(ws.Protection.AllowDeletingRows)) & _
                    Abs(CInt(ws.Protection.AllowSorting)) & _
                    Abs(CInt(ws.Protection.AllowFiltering)) & _
                    Abs(CInt(ws.Protection.AllowUsingPivotTables))
            On Error GoTo 0
        End If
        s = s & vbCrLf
    Next ws
    SA_Huella = s
End Function

' ==========================  Helpers  ==========================

Private Sub SA_Fotografiar(ByVal ws As Worksheet, ByRef e As SA_EstadoHoja)
    e.nombre = ws.Name
    e.contenido = ws.ProtectContents
    e.objetos = ws.ProtectDrawingObjects
    e.escenarios = ws.ProtectScenarios
    ' "Protegida" es protegida de CUALQUIER forma, no solo de contenido. Excel permite
    ' proteger objetos o escenarios sin proteger celdas; si la senal fuera unicamente
    ' ProtectContents, esa hoja se leeria como "abierta" y al reponer se le quitaria la
    ' proteccion que si tenia. Raro, pero es exactamente el tipo de estado que este modulo
    ' promete no tocar.
    e.protegida = (e.contenido Or e.objetos Or e.escenarios)
    e.seleccion = ws.EnableSelection

    ' Las banderas Allow* solo se pueden LEER si la hoja esta protegida. Si no lo esta,
    ' se quedan en False -- y da igual, porque a una hoja no protegida no se le repone nada.
    If e.protegida Then
        On Error Resume Next
        e.fmtCeldas = ws.Protection.AllowFormattingCells
        e.fmtColumnas = ws.Protection.AllowFormattingColumns
        e.fmtFilas = ws.Protection.AllowFormattingRows
        e.insColumnas = ws.Protection.AllowInsertingColumns
        e.insFilas = ws.Protection.AllowInsertingRows
        e.insHipervinculos = ws.Protection.AllowInsertingHyperlinks
        e.delColumnas = ws.Protection.AllowDeletingColumns
        e.delFilas = ws.Protection.AllowDeletingRows
        e.ordenar = ws.Protection.AllowSorting
        e.filtrar = ws.Protection.AllowFiltering
        e.dinamicas = ws.Protection.AllowUsingPivotTables
        On Error GoTo 0
    End If
End Sub

Private Sub SA_Reponer(ByVal ws As Worksheet, ByRef e As SA_EstadoHoja)
    ' Hoja que NO estaba protegida se queda como estaba.
    If Not e.protegida Then Exit Sub

    On Error Resume Next
    ws.Protect Password:=SA_PWD, _
               DrawingObjects:=e.objetos, _
               Contents:=e.contenido, _
               Scenarios:=e.escenarios, _
               UserInterfaceOnly:=True, _
               AllowFormattingCells:=e.fmtCeldas, _
               AllowFormattingColumns:=e.fmtColumnas, _
               AllowFormattingRows:=e.fmtFilas, _
               AllowInsertingColumns:=e.insColumnas, _
               AllowInsertingRows:=e.insFilas, _
               AllowInsertingHyperlinks:=e.insHipervinculos, _
               AllowDeletingColumns:=e.delColumnas, _
               AllowDeletingRows:=e.delFilas, _
               AllowSorting:=e.ordenar, _
               AllowFiltering:=e.filtrar, _
               AllowUsingPivotTables:=e.dinamicas
    ' Solo si CAMBIO. Asignar EnableSelection hace que Excel active la hoja, y como esto
    ' corre sobre las 8, escribirlo siempre dejaba al operador en otra hoja al terminar
    ' cada macro. Como el valor se acaba de fotografiar de esta misma hoja, en la practica
    ' nunca cambia -- la asignacion era pura ceremonia con un efecto secundario caro.
    If ws.EnableSelection <> e.seleccion Then ws.EnableSelection = e.seleccion
    On Error GoTo 0
End Sub
