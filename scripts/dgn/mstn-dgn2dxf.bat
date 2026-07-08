@echo off
REM ============================================================================
REM  mstn-dgn2dxf.bat — Wrapper DGN -> DXF via MicroStation (Windows, local).
REM
REM  Appele par l'app (convertDgnToDxf) avec :
REM     %1 = chemin du .dgn d'entree (fichier temporaire)
REM     %2 = chemin du .dxf de sortie a produire
REM
REM  Config cote app (.env / variables d'environnement) :
REM     DGN_TO_DXF_BIN  = C:\...\geoaino-next\scripts\dgn\mstn-dgn2dxf.bat
REM     DGN_TO_DXF_ARGS = {input} {output}
REM
REM  >>> A ADAPTER : chemin de MicroStation + methode de conversion (voir plus bas).
REM      La ligne de lancement varie selon la version (CONNECT / V8i). Valider une
REM      fois en ligne de commande, puis brancher l'app. Voir docs/SETUP-DGN.md.
REM ============================================================================
setlocal enabledelayedexpansion

set "DGN_IN=%~1"
set "DXF_OUT=%~2"

REM --- 1) Chemin de l'executable MicroStation (a ajuster) ----------------------
set "MSTN=C:\Program Files\Bentley\MicroStation CONNECT Edition\MicroStation\mstn.exe"
if not exist "%MSTN%" (
  echo [mstn-dgn2dxf] Introuvable: "%MSTN%" 1>&2
  echo [mstn-dgn2dxf] Ajuster la variable MSTN dans ce script. 1>&2
  exit /b 2
)

REM --- 2) Passer les chemins a la macro VBA via variables d'environnement -------
set "MSTN_DGN_INPUT=%DGN_IN%"
set "MSTN_DXF_OUTPUT=%DXF_OUT%"

REM --- 3) Lancer MicroStation, ouvrir le DGN, executer la macro, quitter --------
REM  Methode recommandee (macro VBA "DgnToDxf.ConvertDgnToDxf" fournie a cote) :
REM  la macro lit MSTN_DGN_INPUT / MSTN_DXF_OUTPUT, fait "DWG SAVEAS" puis EXIT.
REM  Le switch d'auto-lancement de macro depend de la version — exemples :
REM     CONNECT : "%MSTN%" -wu -i"input.dgn" -wr"vba run [DgnToDxf]ConvertDgnToDxf"
REM     V8i     : ustation.exe -wa... (voir docs/SETUP-DGN.md)
REM  On attend la fin (/wait) avant que l'app lise le DXF.
start "" /wait "%MSTN%" "%DGN_IN%" -wr"vba run [DgnToDxf]ConvertDgnToDxf"

REM --- 4) Verifier la production du DXF ----------------------------------------
if not exist "%DXF_OUT%" (
  echo [mstn-dgn2dxf] Aucun DXF produit (macro/licence/switch a verifier). 1>&2
  exit /b 3
)

endlocal
exit /b 0
