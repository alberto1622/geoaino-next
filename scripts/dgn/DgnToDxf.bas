' ============================================================================
'  DgnToDxf.bas — Macro MicroStation VBA : DGN actif -> DXF, puis quitte.
'
'  Importer dans MicroStation :
'    Utilities > Macro > Visual Basic Editor > File > Import File... (ce .bas),
'    dans un projet VBA nomme "DgnToDxf" (le wrapper appelle
'    "vba run [DgnToDxf]ConvertDgnToDxf").
'
'  La macro lit les chemins depuis les variables d'environnement posees par
'  mstn-dgn2dxf.bat (MSTN_DGN_INPUT / MSTN_DXF_OUTPUT). Le fichier .dgn est deja
'  ouvert (passe en ligne de commande) : on l'enregistre en DXF via le key-in
'  "DWG SAVEAS" (MicroStation choisit DXF d'apres l'extension .dxf), puis EXIT.
' ============================================================================
Sub ConvertDgnToDxf()
    On Error GoTo Fail

    Dim outPath As String
    outPath = Environ$("MSTN_DXF_OUTPUT")
    If Len(outPath) = 0 Then
        Exit Sub
    End If

    ' Sauvegarde du fichier actif au format DXF (extension .dxf => format DXF).
    CadInputQueue.SendCommand "DWG SAVEAS " & outPath

    ' Quitter MicroStation sans boite de dialogue.
    CadInputQueue.SendCommand "EXIT NOUISAVE"
    Exit Sub

Fail:
    ' En cas d'erreur, quitter quand meme pour ne pas bloquer le wrapper (/wait).
    CadInputQueue.SendCommand "EXIT NOUISAVE"
End Sub
