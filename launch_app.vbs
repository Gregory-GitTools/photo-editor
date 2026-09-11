' Запускается с ярлыка "Albom" на рабочем столе вместо PWA с GitHub Pages, чтобы
' работала функция "открыть папку в Проводнике" (она обращается к локальному
' server.py на http://localhost:8642 — с адреса GitHub Pages это невозможно).
' Ничего не показывает в момент запуска сервера (без чёрного окна консоли).

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir

' проверяем, не запущен ли уже сервер (иначе при повторном запуске плодили бы процессы)
Set portCheck = shell.Exec("cmd /c netstat -ano | findstr "":8642 "" | findstr LISTENING")
Do While portCheck.Status = 0
    WScript.Sleep 50
Loop
portBusy = Not portCheck.StdOut.AtEndOfStream

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
