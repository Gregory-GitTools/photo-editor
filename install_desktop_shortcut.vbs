' Разовый установщик: создаёт (или обновляет) ярлык "Albom" на рабочем столе,
' указывающий на launch_app.vbs в ЭТОЙ же папке — запускать один раз после того,
' как папка проекта скопирована на новый компьютер (или на новое место на этом же).
' Требования на компьютере: Python 3 (команда "python" в PATH) и Chrome или Edge.

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")

desktop = shell.SpecialFolders("Desktop")
Set link = shell.CreateShortcut(desktop & "\Albom.lnk")
link.TargetPath = shell.ExpandEnvironmentStrings("%WINDIR%") & "\System32\wscript.exe"
link.Arguments = """" & scriptDir & "\launch_app.vbs"""
link.WorkingDirectory = scriptDir
link.IconLocation = scriptDir & "\icons\app.ico"
link.Save

MsgBox "Готово! Ярлык ""Albom"" создан на рабочем столе.", vbInformation, "Установка Albom"
