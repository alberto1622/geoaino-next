@echo off
REM ============================================================================
REM  Stub de convertisseur DGN->DXF (TESTS UNIQUEMENT).
REM  Ignore le .dgn d'entree et ecrit un DXF minimal valide a la sortie, pour
REM  valider la plomberie DGN_TO_DXF_BIN -> convertDgnToDxf -> toDxfBuffer sans
REM  MicroStation. Arguments : %1 = input.dgn, %2 = output.dxf
REM ============================================================================
setlocal
set "OUT=%~2"
> "%OUT%" echo 0
>> "%OUT%" echo SECTION
>> "%OUT%" echo 2
>> "%OUT%" echo ENTITIES
>> "%OUT%" echo 0
>> "%OUT%" echo ENDSEC
>> "%OUT%" echo 0
>> "%OUT%" echo EOF
endlocal
exit /b 0
