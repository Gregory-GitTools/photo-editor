' Запускается с ярлыка "Albom" на рабочем столе вместо PWA с GitHub Pages, чтобы
' работала функция "открыть папку в Проводнике" (она обращается к локальному
' server.py на http://localhost:8642 — с адреса GitHub Pages это невозможно).
' Ничего не показывает в момент запуска сервера (без чёрного окна консоли).

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir

' проверяем, не запущен ли уже сервер (иначе при повторном запуске плодили бы процессы)
' используем Run (не Exec) с скрытым окном и выводом во временный файл — у Exec нет
' способа скрыть его консольное окно, из-за чего при каждом запуске мелькало чёрное окно
tempFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\albom_port_check.txt"
shell.Run "cmd /c netstat -ano | findstr "":8642 "" | findstr LISTENING > """ & tempFile & """", 0, True
portBusy = False
If fso.FileExists(tempFile) Then
    Set portCheckFile = fso.OpenTextFile(tempFile, 1)
    portBusy = Not portCheckFile.AtEndOfStream
    portCheckFile.Close
    fso.DeleteFile tempFile
End If

If Not portBusy Then
    shell.Run "cmd /c python server.py", 0, False
    WScript.Sleep 800
End If

' на этой машине используется Chrome (профиль "Profile 1"); на другом компьютере без
' Chrome (или без такого профиля) откатываемся на Edge — он есть в Windows по умолчанию.
' Если профиля "Profile 1" не существует, Chrome/Edge сам создаст его — не критично.
chromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe"
edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(chromePath) Then
    shell.Run """" & chromePath & """ --profile-directory=""Profile 1"" --app=http://localhost:8642/", 1, False
ElseIf fso.FileExists(edgePath) Then
    shell.Run """" & edgePath & """ --app=http://localhost:8642/", 1, False
Else
    MsgBox "Не найден ни Chrome, ни Edge. Установите один из этих браузеров.", vbCritical, "Albom"
End If
