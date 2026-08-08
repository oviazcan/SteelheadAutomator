Attribute VB_Name = "Module4"
' === MACRO: SombrearModoSoloPN (v15.3 -- layout v13, plantilla PROTEGIDA) ===
' Sombrea en gris las columnas que NO aplican segun el modo.
' Se ejecuta automaticamente al cambiar H1 (Modo).
'
' V15 (2026-08-07): DOS correcciones reportadas desde piso, con la misma raiz -- el modulo
'   describia la hoja de oidas en vez de leerla.
'
'   (a) El header llegaba hasta M y debe llegar hasta S. El comentario del v13 decia
'       "la metadata llega a M por el merge J3:M4 de Notas Internas; Q3:S4 es el helper
'       'Combinacion no existente', NO se sombrea". Las DOS afirmaciones eran falsas. Medido
'       sobre el XML de la plantilla v13:
'           I3  (col 9)  "Notas Externas:"  + merge J3:M4 (10-13) = su valor
'           P3  (col 16) "Notas Internas:"  + merge Q3:S4 (17-19) = su valor
'           T3  (col 20) "Combinacion no existente"  <- ESTE es el helper
'       O sea: J3:M4 son las EXTERNAS, Q3:S4 son las INTERNAS, y el helper vive una columna
'       mas alla. Con el tope en M, las Notas Internas se quedaban sin sombrear en SOLO_PN:
'       el operador las veia habilitadas cuando no aplican. Ahora A3:S4, que llega justo
'       hasta S y no toca T.
'
'   (b) SE QUITA EL MsgBox DEL CAMINO NORMAL. Sintoma reportado: "jala la primera vez, luego
'       deja de sombrear si sigo iterando entre COTIZACION y SOLO_PN" -- y minutos despues
'       aparecian todos los avisos de golpe, al pasar por la ventana del editor de VBA.
'       No era el sombreado: era el modal. Esta macro se dispara desde Worksheet_Change, asi
'       que cada cambio de H1 abria un MsgBox; con otra ventana al frente el modal queda
'       DETRAS, y mientras espera respuesta VBA esta BLOQUEADO, asi que el siguiente cambio
'       de H1 no se procesa. Los avisos se encolaban y el sombreado "dejaba de funcionar".
'       El aviso ademas no informaba nada: el sombreado ES el feedback, el operador lo tiene
'       enfrente. Un modal por cada cambio de modo era ruido que costaba el hilo de Excel.
'       Queda SOLO el MsgBox de error -- la excepcion se avisa, la norma no.
'       Regla general: una macro disparada por evento no interrumpe con modales.
'
' V15.3 (2026-08-08): la reaccion deja de depender de Worksheet_Change. Diagnostico con
'   SA_PorQueNoSombrea sobre la plantilla real: escribiendo H1 DESDE VBA el evento corre y la
'   macro pinta en 3 ms; eligiendo del dropdown A MANO no pasa nada. En Excel para Mac,
'   seleccionar de una LISTA DE VALIDACION no dispara Worksheet_Change en ese momento -- se
'   difiere hasta que la celda pierde el foco. Eso explica el reporte completo: "no reacciona
'   de inmediato", "hay que guardar, cerrar o cambiarse de pestana", "a veces jala y a veces
'   no" (dependia de si el operador movia el cursor despues).
'   Se agrega SincronizarSombreadoSiHaceFalta, que la hoja Upload llama desde
'   Worksheet_SelectionChange: compara el modo contra el color y repinta solo si difieren.
'   NOTA DE METODO: los tres arreglos anteriores (quitar el modal, acotar las hojas, no tocar
'   la proteccion) atacaron causas plausibles que NO eran la causa. Todos mejoraron el codigo
'   y ninguno arreglo el sintoma. Lo resolvio medir, no razonar mejor.
'
' V15.2 (2026-08-08): EL EVENTO YA NO TOCA LA PROTECCION. Tercer reporte de piso: "se
'   queda parado desde el primer cambio, tarda mucho en reaccionar o no lo hace", con la
'   banda A3:S4 en GRIS mientras H1 decia COTIZACION+NP -- el formato desincronizado del modo.
'   Causa: el v15.1 le puso a una macro de EVENTO el ciclo desproteger/reproteger de Upload,
'   que son 33,811 celdas y 7,504 formulas (con arrays LET/UNIQUE/FILTER, de las caras). Eso
'   se pagaba en CADA cambio de H1 -- y era innecesario de origen: con UserInterfaceOnly
'   activo el VBA escribe sobre la hoja protegida sin desproteger nada.
'   Ahora hay tres caminos, del barato al caro, y el caro casi nunca se recorre:
'     1. PintarModo   -> escribe directo. Cero operaciones de proteccion.
'     2. si falla     -> SA_RehabilitarEscrituraVBA (una vez por sesion) y reintenta.
'     3. si falla     -> desprotege de verdad, pinta, reprotege.
'   Leccion: antes de envolver algo en un mecanismo de proteccion, preguntar si de verdad lo
'   necesita. Aqui la respuesta era no, y el costo lo pagaba el operador en cada tecla.
'
' V15.1 (2026-08-08): pide SOLO la hoja Upload, que es la unica donde escribe.
'   Antes desprotegia las 8 --59,765 celdas y 17,897 formulas, 16 operaciones de
'   Unprotect/Protect-- en CADA cambio de H1, para pintar tres rangos de una sola hoja.
'   Segundo reporte de piso: "ya no reacciona de inmediato como antes; hay que guardar,
'   cerrar o cambiar de pestana, y a veces jala y a veces no". Ahora son 2 operaciones sobre
'   1 hoja. El "hay que cambiar de pestana" era ademas un problema de REDIBUJO, no de
'   logica; lo cubre el repintado forzado de SA_Proteger.
'
' V14 (2026-08-07): desprotege/reprotege via ModProteccion. Esta macro NO escribe valores,
'   escribe FORMATO (.Interior.Color) -- y el formato es justo lo que una hoja protegida
'   bloquea por default (la plantilla v13 esta protegida sin ningun Allow*, asi que
'   AllowFormattingCells = False). Truena en la primera linea que pinta.
'   Se dispara desde Worksheet_Change, o sea que puede correr DENTRO de otra macro que ya
'   desprotegio; el contador de anidamiento de ModProteccion lo cubre -- sin el, esta
'   reprotegeria la hoja a media ejecucion de la de afuera.
'   Ademas se sincroniza F3 -> G3. El quoteName (Nombre Cotizacion/Layout) vive en G3, no en
'   F3: medido sobre el XML de la plantilla v13 (fila 3, label "Nombre Cotizacion/Layout:"
'   en E3=col 5, valor "Nueva Cotizacion" en G3=col 7; F3 esta VACIA). Con F3, en modo
'   SOLO_PN el campo del layout se quedaba GRIS --leyendose como deshabilitado cuando si
'   aplica-- y en su lugar se despintaba una celda vacia. El .xlsm de la plantilla MODERNA ya
'   traia la correccion, el de COMPATIBILIDAD no, y este archivo del repo tampoco: tres
'   copias del mismo modulo, dos desfasadas.
'
' V13 (2026-06-11): adaptado al layout v12 (60 cols visibles A..BH).
'   - Modo en H1 (igual que v11; NO se movio). A2:H2 = titulo merged; A1 vacio.
'   - Header de cotizacion: A3:M4 (la metadata llega a M por el merge J3:M4 de
'     Notas Internas; Q3:S4 es el helper "Combinacion no existente", NO se sombrea).
'   - Nombre Cotizacion/Layout (quoteName) en G3 -> permanece vivo en SOLO_PN.
'   - Cantidad: col I=9 (antes K=11). Rango I9:I508.
'   - Productos: ahora 1 combo en col V=22 (antes 3 grupos X..AI=24..35). Rango V9:V508.
' V12 (2026-05-27): H3 (nombre del layout) vivo en SOLO_PN. Strip A3:T4.
' V11: Modo H1, strip A3:T4, Cantidad K9:K508, Productos X9:AI508.
'
' Target: spreadsheet v12 layout, 60 cols A..BH, datos fila 9+

Sub SombrearModoSoloPN()
    Dim wsUp As Worksheet
    Set wsUp = ThisWorkbook.Sheets("Upload")

    ' V12: el modo esta en H1 (como v11)
    Dim modo As String
    modo = UCase(Trim(wsUp.Range("H1").Value))

    ' 1) CAMINO RAPIDO: escribir directo, SIN tocar la proteccion. Con UserInterfaceOnly
    '    activo (lo pone Workbook_Open) el VBA pinta sobre la hoja protegida sin mas.
    If PintarModo(wsUp, modo) Then Exit Sub

    ' 2) Fallo => UserInterfaceOnly no esta activo en esta sesion (se abrio sin macros y se
    '    habilitaron despues, o alguien protegio la hoja a mano). Reponerlo cuesta UNA vez
    '    por sesion, no una por cada cambio de modo.
    SA_RehabilitarEscrituraVBA
    If PintarModo(wsUp, modo) Then Exit Sub

    ' 3) Ultimo recurso: desproteger de verdad. Aqui si se paga el ciclo completo, pero solo
    '    cuando los dos caminos baratos fallaron.
    On Error GoTo Cleanup
    SA_Desproteger "Upload"
    PintarSinRed wsUp, modo

Cleanup:
    ' Solo se avisa de la EXCEPCION. En el camino normal no hay MsgBox (ver el encabezado).
    Dim errNum As Long, errDesc As String
    errNum = Err.Number: errDesc = Err.Description
    On Error Resume Next
    SA_Proteger
    On Error GoTo 0

    If errNum <> 0 Then
        MsgBox "No se pudo sombrear el modo:" & vbCrLf & errDesc & vbCrLf & vbCrLf & _
               "La protecci" & ChrW(243) & "n qued" & ChrW(243) & " repuesta. El sombreado es s" & _
               ChrW(243) & "lo una ayuda visual: la carga funciona igual.", _
               vbExclamation, "Sombreado incompleto"
    End If
End Sub

' Pinta y devuelve SI LO LOGRO. No toca la proteccion: es el camino que se recorre siempre
' que UserInterfaceOnly este activo, o sea casi siempre. Devolver un Boolean en vez de dejar
' reventar es lo que permite intentar lo barato primero sin pagar lo caro "por si acaso".
Private Function PintarModo(ByVal wsUp As Worksheet, ByVal modo As String) As Boolean
    Dim prevSU As Boolean
    prevSU = Application.ScreenUpdating
    On Error GoTo fallo
    Application.ScreenUpdating = False

    PintarSinRed wsUp, modo

    Application.ScreenUpdating = prevSU
    ' Volver a poner ScreenUpdating en True no siempre redibuja la hoja activa en Excel para
    ' Mac: el color ya esta puesto pero la pantalla sigue mostrando lo anterior hasta que algo
    ' la obligue (guardar, cambiar de pestana). Un scroll de cero filas la obliga.
    If prevSU Then
        On Error Resume Next
        ActiveWindow.SmallScroll Down:=0
        On Error GoTo 0
    End If
    PintarModo = True
    Exit Function
fallo:
    On Error Resume Next
    Application.ScreenUpdating = prevSU
    On Error GoTo 0
    PintarModo = False
End Function

' El pintado en si. Sin manejo de error: quien llama decide que hacer si truena.
Private Sub PintarSinRed(ByVal wsUp As Worksheet, ByVal modo As String)
    Dim grisClaro As Long, verdeClaro As Long
    grisClaro = RGB(125, 125, 125)
    verdeClaro = RGB(232, 245, 233)

    ' Reset: pintar a verde (estado COTIZACION+NP)
    ' Header de cotizacion: A3:S4 (ver el porque de la S en el encabezado del modulo).
    wsUp.Range("A3:S4").Interior.Color = verdeClaro
    ' Datos: CANTIDAD (I=9) y PRODUCTOS (V=22)
    wsUp.Range("I9:I508").Interior.Color = verdeClaro
    wsUp.Range("V9:V508").Interior.Color = verdeClaro

    If InStr(modo, "SOLO") > 0 Then
        ' SOLO_PN: sombrear lo que NO aplica
        ' Header de cotizacion (Empresa, Notas, Asignado, Valida) sombreado;
        ' G3 (Nombre Cotizacion/Layout) siempre aplica -> se restaura a verde.
        wsUp.Range("A3:S4").Interior.Color = grisClaro
        wsUp.Range("G3").Interior.Color = verdeClaro

        ' Cantidad (I=9): no aplica sin cotizacion
        wsUp.Range("I9:I508").Interior.Color = grisClaro
        ' Productos (V=22): no aplican sin cotizacion
        wsUp.Range("V9:V508").Interior.Color = grisClaro
    End If
End Sub

' -- RED DE SEGURIDAD DEL SOMBREADO -------------------------------------------------
' La llama Worksheet_SelectionChange de la hoja Upload, o sea cada vez que el cursor se
' mueve. Compara el modo contra lo que esta pintado y repinta SOLO si no coinciden.
'
' Existe porque en Excel para Mac elegir un valor de una LISTA DE VALIDACION no dispara
' Worksheet_Change en ese momento: Excel lo difiere hasta que la celda pierde el foco. Medido
' con SA_PorQueNoSombrea sobre la plantilla real: escribiendo H1 DESDE VBA el evento corre y
' la macro pinta en 3 ms -- todo correcto. Escogiendo del dropdown A MANO, no pasa nada hasta
' que el operador hace otra cosa. De ahi el reporte: "hay que guardar, cerrar, cambiarse de
' pestana, y a veces jala y a veces no" -- no era azar, era si despues movia el cursor o no.
'
' La leccion es la misma que en los applets del navegador: un EVENTO dispara en momentos
' discretos que el anfitrion decide, y no se puede confiar en que llegue. Lo que si se puede
' es VIGILAR EL ESTADO. Comparar dos colores cuesta practicamente cero, y repintar 3 ms;
' hacerlo en cada movimiento del cursor no se nota, y quita la dependencia del evento.
'
' Se compara contra el color REAL de A3, no contra una variable: asi tambien se corrige el
' desfase si el archivo se abrio ya desincronizado.
Public Sub SincronizarSombreadoSiHaceFalta()
    Dim ws As Worksheet, esSolo As Boolean, estaGris As Boolean
    On Error Resume Next
    Set ws = ThisWorkbook.Sheets("Upload")
    If ws Is Nothing Then Exit Sub
    esSolo = (InStr(UCase(Trim(CStr(ws.Range("H1").Value))), "SOLO") > 0)
    estaGris = (ws.Range("A3").Interior.Color = RGB(125, 125, 125))
    On Error GoTo 0
    If esSolo <> estaGris Then SombrearModoSoloPN
End Sub
